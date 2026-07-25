import {
  DPOP_AUTH_SCHEME,
  MITA_HEADERS,
  SUPPORTED_DPOP_ALGORITHMS,
  isDPoPVerificationError,
  verifyDPoP,
  type DPoPAlgorithm,
  type DPoPProof,
} from '@mita/core';
import { Redis } from '@upstash/redis';
import type { Duration, RatelimitConfig } from '@upstash/ratelimit';

import {
  createRateLimiter,
  type RateLimitDegradation,
  type RateLimitFailureMode,
  type RateLimiter,
} from './ratelimit';
import { createReplayStore, type ReplayStore } from './replay';
import { verifyTurnstileToken, type TurnstileChallenge } from './turnstile';

/** Fail policy for a dependency the guard consults over the network. */
export type GuardFailureMode = RateLimitFailureMode;

export type SecurityFailureReason =
  | 'rate_limited'
  | 'rate_limit_unavailable'
  | 'turnstile_missing'
  | 'turnstile_rejected'
  | 'turnstile_unavailable'
  | 'dpop_missing'
  | 'dpop_invalid'
  | 'dpop_nonce_required'
  | 'dpop_replayed'
  | 'store_unavailable';

export type SecurityCheck =
  | {
      readonly success: true;
      /** Bucket the rate limiter charged this request to. */
      readonly identifier: string;
      /**
       * Headers to merge into the eventual response. Carries the next `DPoP-Nonce`,
       * without which the client cannot sign its following request.
       */
      readonly headers: Headers;
      readonly proof?: DPoPProof;
      readonly turnstile?: TurnstileChallenge;
      /** Background work owed by the rate limiter; hand it to `ctx.waitUntil()` on Edge. */
      readonly pending: Promise<unknown>;
    }
  | {
      readonly success: false;
      readonly reason: SecurityFailureReason;
      /** Ready to return from a Route Handler as-is. */
      readonly response: Response;
      /**
       * Carried on rejections too: the rate limiter records analytics for denied requests
       * as well, and those are the ones worth recording. Dropping it lets an Edge runtime
       * tear the isolate down mid-write.
       */
      readonly pending: Promise<unknown>;
    };

export interface GuardRateLimitOptions {
  requests?: number;
  window?: Duration;
  limiter?: RatelimitConfig['limiter'];
  prefix?: string;
  identifier?: (request: Request) => string | null | undefined;
  /** Defaults to `'open'`: an Upstash outage should not take the endpoint down. */
  failureMode?: RateLimitFailureMode;
  timeoutMs?: number;
  onDegraded?: (degradation: RateLimitDegradation, cause?: unknown) => void;
  analytics?: boolean;
  ephemeralCache?: Map<string, number> | false;
}

export interface GuardTurnstileOptions {
  secretKey: string;
  /** Reject requests that carry no token at all. Defaults to true. */
  required?: boolean;
  allowedHostnames?: readonly string[];
  expectedAction?: string;
  maxAgeSeconds?: number;
  timeoutMs?: number;
  endpoint?: string;
  /**
   * Defaults to `'closed'`. Failing open would let anyone who can blackhole siteverify
   * skip the human check entirely, which is an exploitable path rather than a mere
   * degradation.
   */
  failureMode?: GuardFailureMode;
}

export interface GuardDPoPOptions {
  /** Reject requests that carry no proof. Defaults to true. */
  required?: boolean;
  maxAgeSeconds?: number;
  clockToleranceSeconds?: number;
  algorithms?: readonly DPoPAlgorithm[];
  /** Lifetime of an issued nonce. */
  nonceTtlMs?: number;
  /** Key namespace for nonces and spent proof identifiers. */
  prefix?: string;
  timeoutMs?: number;
  onUnavailable?: (cause: unknown) => void;
}

export interface CreateSecurityGuardOptions {
  redis: Redis | { url: string; token: string };
  rateLimit?: GuardRateLimitOptions;
  /** Enables Turnstile verification. Omit to skip it. */
  turnstile?: GuardTurnstileOptions;
  /** Enables DPoP proof and nonce verification. Omit to skip both. */
  dpop?: GuardDPoPOptions | true;
  /**
   * Public URL a DPoP proof is bound to. Override when a proxy rewrites the request URL,
   * since `htu` must match what the client signed.
   */
  resolveUrl?: (request: Request) => string;
  /** Current time in epoch milliseconds. Injected by tests. */
  now?: () => number;
}

export interface SecurityGuard {
  verify(request: Request): Promise<SecurityCheck>;
  /** Escape hatches for callers that need one check without the others. */
  readonly rateLimiter: RateLimiter;
  readonly replayStore: ReplayStore;
}

/**
 * Composes rate limiting, Turnstile verification and DPoP replay protection into one
 * Web-standard `Request` -> `Response` check.
 *
 * Everything that can reject a request without spending anything runs first: the rate
 * limit, then the mere presence of a Turnstile token. Only then does the proof get
 * verified and its nonce redeemed, and the token is finally spent at Cloudflare last.
 *
 * That last step is ordered by correctness rather than by cost. Cloudflare accepts a
 * token exactly once, while RFC 9449 requires a client's first request to be rejected
 * with `use_dpop_nonce` and retried. Verifying the token before the nonce would burn it
 * on precisely the request that is guaranteed to be retried, leaving the client with no
 * way to ever satisfy both checks at once. Deferring it also means a request carrying a
 * bad proof no longer costs a round trip to Cloudflare.
 */
export function createSecurityGuard(options: CreateSecurityGuardOptions): SecurityGuard {
  const { rateLimit = {}, turnstile, dpop, resolveUrl = (request) => request.url, now } = options;

  const redis =
    options.redis instanceof Redis
      ? options.redis
      : new Redis({ url: options.redis.url, token: options.redis.token });

  const dpopOptions: GuardDPoPOptions | undefined = dpop === true ? {} : dpop;

  const rateLimiter = createRateLimiter({ redis, ...rateLimit });
  const replayStore = createReplayStore({
    redis,
    ...(dpopOptions?.prefix === undefined ? {} : { prefix: dpopOptions.prefix }),
    ...(dpopOptions?.nonceTtlMs === undefined ? {} : { nonceTtlMs: dpopOptions.nonceTtlMs }),
    ...(dpopOptions?.timeoutMs === undefined ? {} : { timeoutMs: dpopOptions.timeoutMs }),
    ...(dpopOptions?.onUnavailable === undefined
      ? {}
      : { onUnavailable: dpopOptions.onUnavailable }),
    proofTtlMs: proofLifetimeMs(dpopOptions),
  });

  const algorithms = dpopOptions?.algorithms ?? SUPPORTED_DPOP_ALGORITHMS;

  return {
    rateLimiter,
    replayStore,

    async verify(request) {
      const decision = await rateLimiter.limit(request);

      if (!decision.success) {
        return decision.degraded
          ? failure(
              'rate_limit_unavailable',
              unavailableResponse('rate_limit_unavailable'),
              decision.pending,
            )
          : failure(
              'rate_limited',
              rateLimitedResponse(decision.limit, decision.reset),
              decision.pending,
            );
      }

      const token = turnstile === undefined ? null : request.headers.get(MITA_HEADERS.turnstile);

      if (turnstile !== undefined && token === null && turnstile.required !== false) {
        return failure('turnstile_missing', forbiddenResponse('turnstile_missing'), decision.pending);
      }

      const dpopOutcome =
        dpopOptions === undefined
          ? emptyDPoPOutcome
          : await runDPoP({
              request,
              options: dpopOptions,
              url: resolveUrl(request),
              algorithms,
              replayStore,
              now: now?.(),
              pending: decision.pending,
            });

      if (dpopOutcome.failure !== null) {
        return dpopOutcome.failure;
      }

      const turnstileOutcome = await runTurnstile(token, turnstile, now?.(), decision.pending);

      if (turnstileOutcome.failure !== null) {
        return turnstileOutcome.failure;
      }

      const { proof } = dpopOutcome;
      const headers = new Headers();

      if (proof !== undefined) {
        const issued = await replayStore.issueNonce();

        if (!issued.ok) {
          return failure(
            'store_unavailable',
            unavailableResponse('store_unavailable'),
            decision.pending,
          );
        }

        headers.set(MITA_HEADERS.dpopNonce, issued.nonce.value);
      }

      return success(
        decision.identifier,
        headers,
        decision.pending,
        proof,
        turnstileOutcome.challenge,
      );
    },
  };
}

type SecurityFailure = SecurityCheck & { success: false };

interface TurnstileOutcome {
  /** Non-null when the request must be denied. */
  failure: SecurityFailure | null;
  challenge?: TurnstileChallenge;
}

interface DPoPOutcome {
  /** Non-null when the request must be denied. */
  failure: SecurityFailure | null;
  /** Absent when DPoP is disabled, or optional and the request carried no proof. */
  proof?: DPoPProof;
}

const emptyDPoPOutcome: DPoPOutcome = { failure: null };

interface RunDPoPInput {
  request: Request;
  options: GuardDPoPOptions;
  /** Public URL the proof must be bound to. */
  url: string;
  algorithms: readonly DPoPAlgorithm[];
  replayStore: ReplayStore;
  now: number | undefined;
  pending: Promise<unknown>;
}

async function runDPoP({
  request,
  options,
  url,
  algorithms,
  replayStore,
  now,
  pending,
}: RunDPoPInput): Promise<DPoPOutcome> {
  const proofHeader = request.headers.get(MITA_HEADERS.dpop);

  if (proofHeader === null) {
    return options.required === false
      ? emptyDPoPOutcome
      : {
          failure: await challengeFailure(
            'dpop_missing',
            'invalid_dpop_proof',
            algorithms,
            replayStore,
            pending,
          ),
        };
  }

  let proof: DPoPProof;

  try {
    proof = await verifyDPoP(proofHeader, {
      method: request.method,
      url,
      ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
      ...(options.clockToleranceSeconds === undefined
        ? {}
        : { clockToleranceSeconds: options.clockToleranceSeconds }),
      algorithms,
      ...(now === undefined ? {} : { now }),
    });
  } catch (cause) {
    if (!isDPoPVerificationError(cause)) {
      throw cause;
    }

    return {
      failure: await challengeFailure(
        'dpop_invalid',
        'invalid_dpop_proof',
        algorithms,
        replayStore,
        pending,
      ),
    };
  }

  // The proof echoes a nonce we cannot recognise on sight — it is opaque and unsigned
  // by design — so its validity is settled entirely by the store.
  if (proof.nonce === undefined) {
    return {
      failure: await challengeFailure(
        'dpop_nonce_required',
        'use_dpop_nonce',
        algorithms,
        replayStore,
        pending,
      ),
    };
  }

  const redeemed = await replayStore.consumeNonce(proof.nonce);

  if (!redeemed.ok) {
    return {
      failure:
        redeemed.reason === 'unavailable'
          ? failure('store_unavailable', unavailableResponse('store_unavailable'), pending)
          : await challengeFailure(
              'dpop_nonce_required',
              'use_dpop_nonce',
              algorithms,
              replayStore,
              pending,
            ),
    };
  }

  const claimed = await replayStore.rememberProof({ jti: proof.jti, jkt: proof.jkt });

  if (!claimed.ok) {
    return {
      failure:
        claimed.reason === 'unavailable'
          ? failure('store_unavailable', unavailableResponse('store_unavailable'), pending)
          : await challengeFailure(
              'dpop_replayed',
              'invalid_dpop_proof',
              algorithms,
              replayStore,
              pending,
            ),
    };
  }

  return { failure: null, proof };
}

/**
 * Spends the token with Cloudflare.
 *
 * A `null` token means there is nothing to verify: either Turnstile is off, or it is
 * optional and the request carried none. The required-but-absent case never reaches here,
 * having been rejected before any of the expensive checks ran.
 */
async function runTurnstile(
  token: string | null,
  options: GuardTurnstileOptions | undefined,
  now: number | undefined,
  pending: Promise<unknown>,
): Promise<TurnstileOutcome> {
  if (options === undefined || token === null) {
    return { failure: null };
  }

  const result = await verifyTurnstileToken({
    secretKey: options.secretKey,
    token,
    ...(options.allowedHostnames === undefined
      ? {}
      : { allowedHostnames: options.allowedHostnames }),
    ...(options.expectedAction === undefined ? {} : { expectedAction: options.expectedAction }),
    ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(now === undefined ? {} : { now }),
  });

  if (result.success) {
    return { failure: null, challenge: result.challenge };
  }

  if (result.reason === 'rejected') {
    return {
      failure: failure('turnstile_rejected', forbiddenResponse('turnstile_rejected'), pending),
    };
  }

  return (options.failureMode ?? 'closed') === 'open'
    ? { failure: null }
    : {
        failure: failure(
          'turnstile_unavailable',
          unavailableResponse('turnstile_unavailable'),
          pending,
        ),
      };
}

/** Keeps a spent `jti` on record for at least as long as a proof stays acceptable. */
function proofLifetimeMs(options: GuardDPoPOptions | undefined): number {
  const maxAgeSeconds = options?.maxAgeSeconds ?? 60;
  const clockToleranceSeconds = options?.clockToleranceSeconds ?? 5;

  return (maxAgeSeconds + clockToleranceSeconds * 2) * 1000;
}

function success(
  identifier: string,
  headers: Headers,
  pending: Promise<unknown>,
  proof: DPoPProof | undefined,
  turnstile: TurnstileChallenge | undefined,
): SecurityCheck {
  return {
    success: true,
    identifier,
    headers,
    pending,
    ...(proof === undefined ? {} : { proof }),
    ...(turnstile === undefined ? {} : { turnstile }),
  };
}

function failure(
  reason: SecurityFailureReason,
  response: Response,
  pending: Promise<unknown>,
): SecurityFailure {
  return { success: false, reason, response, pending };
}

/**
 * Answers with a fresh nonce so the client can immediately retry, which is the whole
 * point of the RFC 9449 `use_dpop_nonce` handshake. A store that cannot mint one leaves
 * the client no way forward, so that becomes a 503 instead.
 */
async function challengeFailure(
  reason: SecurityFailureReason,
  error: string,
  algorithms: readonly DPoPAlgorithm[],
  replayStore: ReplayStore,
  pending: Promise<unknown>,
): Promise<SecurityFailure> {
  const issued = await replayStore.issueNonce();

  if (!issued.ok) {
    return failure('store_unavailable', unavailableResponse('store_unavailable'), pending);
  }

  const headers = new Headers({
    'www-authenticate': `${DPOP_AUTH_SCHEME} error="${error}", algs="${algorithms.join(' ')}"`,
    [MITA_HEADERS.dpopNonce]: issued.nonce.value,
  });

  return failure(reason, problemResponse(401, reason, headers), pending);
}

function rateLimitedResponse(limit: number, reset: number): Response {
  const retryAfterSeconds = Math.max(0, Math.ceil((reset - Date.now()) / 1000));

  return problemResponse(
    429,
    'rate_limited',
    new Headers({
      'ratelimit-limit': String(limit),
      'ratelimit-remaining': '0',
      'ratelimit-reset': String(retryAfterSeconds),
      'retry-after': String(retryAfterSeconds),
    }),
  );
}

function forbiddenResponse(reason: SecurityFailureReason): Response {
  return problemResponse(403, reason, new Headers());
}

/** A dependency could not answer, so nothing was proven either way. */
function unavailableResponse(reason: SecurityFailureReason): Response {
  return problemResponse(503, reason, new Headers());
}

function problemResponse(status: number, reason: SecurityFailureReason, headers: Headers): Response {
  headers.set('content-type', 'application/json');

  return new Response(JSON.stringify({ error: reason }), { status, headers });
}
