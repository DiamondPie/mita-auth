import { Ratelimit, type Duration, type RatelimitConfig } from '@upstash/ratelimit';
import type { Redis } from '@upstash/redis';

export const DEFAULT_RATE_LIMIT_REQUESTS = 10;
export const DEFAULT_RATE_LIMIT_WINDOW: Duration = '1 m';
export const DEFAULT_RATE_LIMIT_TIMEOUT_MS = 5000;

/**
 * Bucket shared by every request whose origin could not be identified.
 *
 * Sharing one bucket is deliberate: unidentified traffic is throttled collectively
 * rather than waved through.
 */
export const UNIDENTIFIED_RATE_LIMIT_KEY = 'mita:unidentified';

/**
 * Headers consulted in order to derive the client IP; the first one present wins.
 *
 * Every one of these is client-supplied unless a trusted proxy overwrites it, and the order
 * is a guess at which proxy is in front. It is fixed, so it cannot know which header *this*
 * deployment's proxy is the one overwriting — behind anything but Cloudflare, a header the
 * visitor set can win over the header the platform set. Naming the right one through
 * `clientIpHeader` is the only way to be sure.
 */
export const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;

/**
 * Ceiling for an IP read out of a header. The longest legitimate value is an IPv6 address
 * with a zone id, at 45 characters.
 *
 * Without it a forged header is cheap amplification: every distinct value becomes its own
 * Redis key carrying the window's TTL, and the runtime's own header limit — around 16 KB —
 * is the only bound on how big each of them gets. It applies to a named `clientIpHeader`
 * too: naming a header says a proxy overwrites it, and a proxy that turned out not to is
 * exactly the case worth surviving.
 *
 * It bounds nothing a caller supplies through `identifier`. That value is theirs, and a
 * library that truncated it would be corrupting a key rather than protecting anything.
 */
export const MAX_CLIENT_IP_LENGTH = 64;

/** What to do when the limiter cannot reach a verdict. */
export type RateLimitFailureMode = 'open' | 'closed';

/** Why a decision was made without Redis. */
export type RateLimitDegradation = 'timeout' | 'error';

export interface RateLimitDecision {
  readonly success: boolean;
  readonly identifier: string;
  readonly limit: number;
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets. Meaningless while `degraded`. */
  readonly reset: number;
  /**
   * True when Redis did not produce this verdict and `failureMode` decided it instead.
   * A degraded rejection is a 503, not a 429 — nobody exceeded anything.
   */
  readonly degraded: boolean;
  /**
   * Background work the limiter still owes. Edge runtimes must hand it to
   * `ctx.waitUntil()`, or analytics and multi-region sync are killed mid-flight.
   */
  readonly pending: Promise<unknown>;
}

export interface CreateRateLimiterOptions {
  redis: Redis;
  /** Requests allowed per window. Defaults to 10. */
  requests?: number;
  /** Window length, e.g. `'1 m'` or `'10 s'`. Defaults to `'1 m'`. */
  window?: Duration;
  /** Replaces the default sliding window with any `Ratelimit.*` algorithm. */
  limiter?: RatelimitConfig['limiter'];
  /** Key prefix in Redis. Defaults to `@upstash/ratelimit`. */
  prefix?: string;
  /**
   * The one header this deployment's proxy is known to overwrite. Without it the default
   * identifier guesses, trying {@link CLIENT_IP_HEADERS} in a fixed order that is right
   * behind Cloudflare and wrong nearly everywhere else.
   *
   * Ignored when {@link identifier} is supplied — that replaces the resolver this configures.
   */
  clientIpHeader?: string;
  /**
   * Derives the bucket key from the request. Returning `null` or `undefined` falls back
   * to {@link UNIDENTIFIED_RATE_LIMIT_KEY}. Defaults to {@link resolveClientIp}.
   */
  identifier?: (request: Request) => string | null | undefined;
  /**
   * Verdict to use when Redis is unreachable. Defaults to `'open'`: rate limiting protects
   * availability, so an Upstash outage should not take the whole endpoint down with it.
   * Replay protection makes the opposite choice — see the nonce store.
   */
  failureMode?: RateLimitFailureMode;
  /** Budget for the Redis round trip. Defaults to 5000 ms. */
  timeoutMs?: number;
  /** Called whenever a decision is degraded, so an outage is not silently absorbed. */
  onDegraded?: (degradation: RateLimitDegradation, cause?: unknown) => void;
  analytics?: boolean;
  ephemeralCache?: Map<string, number> | false;
}

export interface RateLimiter {
  limit(request: Request): Promise<RateLimitDecision>;
}

/**
 * Reads the client IP from the usual proxy headers.
 *
 * With `header`, only that one is consulted and its value is taken whole: naming a header is
 * a statement that this deployment's proxy controls it, and a comma in a value like that is
 * data rather than a chain. Without it, {@link CLIENT_IP_HEADERS} are tried in order.
 *
 * Returns `null` when nothing usable was found, which the limiter maps to the shared
 * unidentified bucket.
 */
export function resolveClientIp(request: Request, header?: string): string | null {
  if (header !== undefined) {
    // Not falling back to the list: a deployment that named a header and did not get it is
    // one whose proxy is misconfigured, and guessing would hide that behind a header the
    // visitor is free to set.
    return usableIp(request.headers.get(header)?.trim());
  }

  for (const name of CLIENT_IP_HEADERS) {
    const value = request.headers.get(name);

    if (value === null) {
      continue;
    }

    // `X-Forwarded-For` is a chain. The left-most entry is the original client only when the
    // proxy in front overwrites the header; a proxy that appends — which nginx's own
    // `$proxy_add_x_forwarded_for` example does — leaves whatever the client sent sitting
    // there, and this reads that instead.
    const candidate = usableIp(value.split(',')[0]?.trim());

    // Falling through rather than returning `null`: an unusable value is treated as absent,
    // so a forged `CF-Connecting-IP` does not also suppress a real `X-Real-Ip` behind it.
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

/** `null` for anything that cannot be a client IP: absent, empty, or beyond the ceiling. */
function usableIp(value: string | undefined): string | null {
  return value === undefined || value.length === 0 || value.length > MAX_CLIENT_IP_LENGTH
    ? null
    : value;
}

/**
 * Wraps `@upstash/ratelimit` in a sliding window with an explicit failure policy.
 *
 * Upstash's own `timeout` already fails open by reporting success, which silently
 * overrides a `'closed'` policy, so that outcome is re-decided here.
 */
export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  const {
    redis,
    requests = DEFAULT_RATE_LIMIT_REQUESTS,
    window = DEFAULT_RATE_LIMIT_WINDOW,
    limiter = Ratelimit.slidingWindow(requests, window),
    prefix,
    clientIpHeader,
    identifier = (request: Request) => resolveClientIp(request, clientIpHeader),
    failureMode = 'open',
    timeoutMs = DEFAULT_RATE_LIMIT_TIMEOUT_MS,
    onDegraded,
    analytics,
    ephemeralCache,
  } = options;

  const ratelimit = new Ratelimit({
    redis,
    limiter,
    timeout: timeoutMs,
    ...(prefix === undefined ? {} : { prefix }),
    ...(analytics === undefined ? {} : { analytics }),
    ...(ephemeralCache === undefined ? {} : { ephemeralCache }),
  });

  const degrade = (
    identifierUsed: string,
    degradation: RateLimitDegradation,
    cause?: unknown,
  ): RateLimitDecision => {
    onDegraded?.(degradation, cause);

    return {
      success: failureMode === 'open',
      identifier: identifierUsed,
      limit: requests,
      remaining: 0,
      reset: Date.now(),
      degraded: true,
      pending: Promise.resolve(),
    };
  };

  return {
    async limit(request) {
      const candidate = identifier(request);
      // Not `??`: an identifier that returned `''` would otherwise build a key ending in a
      // colon, collecting every anonymous caller in one bucket that nothing documents.
      const identifierUsed =
        candidate === null || candidate === undefined || candidate === ''
          ? UNIDENTIFIED_RATE_LIMIT_KEY
          : candidate;

      try {
        const result = await ratelimit.limit(identifierUsed);

        if (result.reason === 'timeout') {
          return { ...degrade(identifierUsed, 'timeout'), pending: result.pending };
        }

        return {
          success: result.success,
          identifier: identifierUsed,
          limit: result.limit,
          remaining: result.remaining,
          reset: result.reset,
          degraded: false,
          pending: result.pending,
        };
      } catch (cause) {
        return degrade(identifierUsed, 'error', cause);
      }
    },
  };
}
