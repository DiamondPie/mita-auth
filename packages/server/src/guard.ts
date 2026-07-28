import {
  DPOP_AUTH_SCHEME,
  MITA_HEADERS,
  MitaError,
  SUPPORTED_DPOP_ALGORITHMS,
  isDPoPVerificationError,
  verifyDPoP,
  type DPoPAlgorithm,
  type DPoPProof,
} from '@mita-auth/core';
import { Redis } from '@upstash/redis';
import type { Duration, RatelimitConfig } from '@upstash/ratelimit';

import {
  createRateLimiter,
  resolveClientIp,
  type RateLimitDegradation,
  type RateLimitFailureMode,
  type RateLimiter,
} from './ratelimit';
import { createReplayStore, type ReplayStore } from './replay';
import {
  verifyTurnstileToken,
  type TurnstileChallenge,
  type TurnstileUnavailable,
} from './turnstile';

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
  /**
   * Forward the visitor's IP to siteverify as `remoteip`, which Cloudflare uses to sharpen
   * its verdict. `true` reads it with {@link resolveClientIp}, honouring
   * {@link CreateSecurityGuardOptions.clientIpHeader}; a function derives it some other way.
   *
   * Off by default, and deliberately: the headers `resolveClientIp` reads are client-supplied
   * unless a trusted proxy overwrites them, and a wrong IP makes the scoring worse rather
   * than better. Turn it on once `clientIpHeader` names the header this platform sets —
   * without it the header order is a guess, and handing Cloudflare a value the visitor chose
   * is what that guess costs when it is wrong.
   */
  remoteIp?: boolean | ((request: Request) => string | null | undefined);
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
  /**
   * Called when siteverify reached no verdict, with the codes and cause behind it.
   *
   * Without this the only signal is a 503 whose body says `turnstile_unavailable`, and the
   * reasons are worlds apart: a Cloudflare outage, a runtime with no `AbortSignal.timeout`,
   * and a response that was not JSON all arrive looking identical.
   */
  onUnavailable?: (verification: TurnstileUnavailable) => void;
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
  /**
   * An Upstash client, or the credentials to build one from.
   *
   * Any of the platform entry points will do — the `Redis` classes exported by
   * `@upstash/redis`, `/cloudflare` and `/fastly` are structurally identical.
   *
   * Optional only because {@link rateLimiter} and {@link replayStore} can be supplied
   * ready-made; whichever of the two is left to be built needs this. The replay store is
   * built on demand, so a guard with {@link dpop} omitted never asks for one at all.
   */
  redis?: Redis | { url: string; token: string };
  /**
   * A limiter to use instead of building a Redis-backed one, which makes {@link rateLimit}
   * moot. `@mita-auth/server/memory` has one for local development.
   */
  rateLimiter?: RateLimiter;
  /** A replay store to use instead of building a Redis-backed one. Same as above. */
  replayStore?: ReplayStore;
  /**
   * The one header this deployment's proxy is known to overwrite, e.g. `'cf-connecting-ip'`
   * on Cloudflare or `'x-real-ip'` on Vercel. Without it {@link resolveClientIp} guesses,
   * trying a fixed list in an order that is right behind Cloudflare and wrong nearly
   * everywhere else.
   *
   * It sits here rather than under {@link rateLimit} because it is a fact about the
   * deployment, not about one check: the rate limiter and `turnstile.remoteIp` ask the same
   * question of the same request, and two fields would only invite two answers.
   *
   * `rateLimit.identifier` still wins over it — that replaces the resolver outright.
   */
  clientIpHeader?: string;
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
  const {
    rateLimit = {},
    clientIpHeader,
    turnstile,
    dpop,
    resolveUrl = (request) => request.url,
    now,
  } = options;

  const client = resolveRedis(options.redis);

  /** Refused here rather than at the first request, where it would read as an outage. */
  const requireRedis = (missing: string): Redis => {
    if (client === undefined) {
      throw new MitaError(
        'guard.redis_required',
        `A guard needs \`redis\` unless a ${missing} is supplied ready-made. \`@mita-auth/server/memory\` has in-process stores for local development.`,
      );
    }

    return client;
  };

  const dpopOptions: GuardDPoPOptions | undefined = dpop === true ? {} : dpop;

  const rateLimiter =
    options.rateLimiter ??
    createRateLimiter({
      redis: requireRedis('rateLimiter'),
      ...(clientIpHeader === undefined ? {} : { clientIpHeader }),
      ...rateLimit,
    });

  let replayStoreInstance: ReplayStore | undefined;

  /**
   * Built on demand rather than up front. `verify()` reaches for it only when DPoP is on,
   * and a guard that wants nothing but rate limiting and Turnstile should not be asked for a
   * Redis client to satisfy a dependency it never touches.
   */
  const resolveReplayStore = (): ReplayStore =>
    (replayStoreInstance ??=
      options.replayStore ??
      createReplayStore({
        redis: requireRedis('replayStore'),
        ...(dpopOptions?.prefix === undefined ? {} : { prefix: dpopOptions.prefix }),
        ...(dpopOptions?.nonceTtlMs === undefined ? {} : { nonceTtlMs: dpopOptions.nonceTtlMs }),
        ...(dpopOptions?.timeoutMs === undefined ? {} : { timeoutMs: dpopOptions.timeoutMs }),
        ...(dpopOptions?.onUnavailable === undefined
          ? {}
          : { onUnavailable: dpopOptions.onUnavailable }),
        proofTtlMs: proofLifetimeMs(dpopOptions),
      }));

  // DPoP is the one switch that guarantees `verify()` will need it, so that case keeps the
  // property `requireRedis` is written for: refused while the guard is being built, rather
  // than at a first request where an absent client would read as an outage.
  if (dpopOptions !== undefined) {
    resolveReplayStore();
  }

  const algorithms = dpopOptions?.algorithms ?? SUPPORTED_DPOP_ALGORITHMS;

  return {
    rateLimiter,

    get replayStore() {
      return resolveReplayStore();
    },

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
              rateLimitedResponse(decision.limit, decision.reset, now?.() ?? Date.now()),
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
              // Called rather than read off `this`, which an object literal cannot type.
              replayStore: resolveReplayStore(),
              now: now?.(),
              pending: decision.pending,
            });

      if (dpopOutcome.failure !== null) {
        return dpopOutcome.failure;
      }

      const turnstileOutcome = await runTurnstile(
        request,
        token,
        turnstile,
        clientIpHeader,
        now?.(),
        decision.pending,
      );

      if (turnstileOutcome.failure !== null) {
        return turnstileOutcome.failure;
      }

      const { proof } = dpopOutcome;
      const headers = new Headers();

      if (proof !== undefined) {
        const issued = await resolveReplayStore().issueNonce();

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
  request: Request,
  token: string | null,
  options: GuardTurnstileOptions | undefined,
  clientIpHeader: string | undefined,
  now: number | undefined,
  pending: Promise<unknown>,
): Promise<TurnstileOutcome> {
  if (options === undefined || token === null) {
    return { failure: null };
  }

  const remoteIp = resolveRemoteIp(request, options.remoteIp, clientIpHeader);

  const result = await verifyTurnstileToken({
    secretKey: options.secretKey,
    token,
    ...(remoteIp === null ? {} : { remoteIp }),
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

  // Everything that made this unknowable is in `result`, and the 503 below carries none of
  // it. Handing it over here is the only place a deployment can learn the difference.
  options.onUnavailable?.(result);

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

/** `null` when nothing usable was found, which leaves `remoteip` off the request entirely. */
function resolveRemoteIp(
  request: Request,
  remoteIp: GuardTurnstileOptions['remoteIp'],
  clientIpHeader: string | undefined,
): string | null {
  if (remoteIp === undefined || remoteIp === false) {
    return null;
  }

  const resolved =
    remoteIp === true ? resolveClientIp(request, clientIpHeader) : remoteIp(request);

  return resolved === null || resolved === undefined || resolved === '' ? null : resolved;
}

/**
 * Builds the Upstash client, or takes the one it was handed.
 *
 * Told apart by shape rather than by `instanceof`: `@upstash/redis` publishes a separate
 * subclass per platform entry point — `/cloudflare` and `/fastly` alongside the default Node
 * one — and they share a base class but not an identity. An identity check would reject
 * precisely the entry points those runtimes are meant to use, and would then quietly build a
 * second client with no URL at all.
 */
function resolveRedis(redis: CreateSecurityGuardOptions['redis']): Redis | undefined {
  if (redis === undefined) {
    return undefined;
  }

  return 'url' in redis ? new Redis(redis) : redis;
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

function rateLimitedResponse(limit: number, reset: number, now: number): Response {
  const retryAfterSeconds = Math.max(0, Math.ceil((reset - now) / 1000));

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
