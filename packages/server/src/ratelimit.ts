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
 * Every one of these is client-supplied unless a trusted proxy overwrites it. Behind
 * Cloudflare or Vercel that is guaranteed; on a bare Node server it is not, and the
 * deployment must either strip them at the edge or pass its own `identifier`.
 */
export const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;

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
 * Returns `null` when none is present, which the limiter maps to the shared
 * unidentified bucket.
 */
export function resolveClientIp(request: Request): string | null {
  for (const header of CLIENT_IP_HEADERS) {
    const value = request.headers.get(header);

    if (value === null) {
      continue;
    }

    // `X-Forwarded-For` is a chain; the left-most entry is the original client.
    const candidate = value.split(',')[0]?.trim();

    if (candidate !== undefined && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
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
    identifier = resolveClientIp,
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
      const identifierUsed = identifier(request) ?? UNIDENTIFIED_RATE_LIMIT_KEY;

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
