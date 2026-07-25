import { MitaError, createNonce, nonceSchema, type Nonce } from '@mita/core';
import type { Redis } from '@upstash/redis';

export const DEFAULT_REPLAY_STORE_PREFIX = 'mita';

/** How long an issued nonce stays redeemable. */
export const DEFAULT_NONCE_TTL_MS = 300_000;

/**
 * How long a spent `jti` is remembered. Must cover the verifier's acceptance window
 * (`@mita/core` defaults to 60 s max age plus 5 s clock tolerance), or a proof becomes
 * replayable again while it is still considered fresh.
 */
export const DEFAULT_PROOF_TTL_MS = 70_000;

export const DEFAULT_REPLAY_STORE_TIMEOUT_MS = 5000;

/** Why a nonce or proof was refused. */
export type ReplayRejection = 'unknown_nonce' | 'replayed';

/**
 * `unavailable` is kept apart from a rejection on purpose: not knowing whether a value
 * was already spent is not the same as knowing it was. Both deny the request, but only
 * one of them is the caller's fault.
 */
export type ReplayCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReplayRejection }
  | { readonly ok: false; readonly reason: 'unavailable'; readonly cause: unknown };

export type NonceIssue =
  | { readonly ok: true; readonly nonce: Nonce }
  | { readonly ok: false; readonly reason: 'unavailable'; readonly cause: unknown };

export interface CreateReplayStoreOptions {
  redis: Redis;
  /** Key namespace in Redis. Defaults to `mita`. */
  prefix?: string;
  /** Lifetime of an issued nonce. Defaults to 5 minutes. */
  nonceTtlMs?: number;
  /** Lifetime of a remembered `jti`. Defaults to 70 seconds. */
  proofTtlMs?: number;
  /** Budget for a single Redis round trip. Defaults to 5000 ms. */
  timeoutMs?: number;
  /** Called whenever Redis could not answer, so a fail-closed outage stays visible. */
  onUnavailable?: (cause: unknown) => void;
}

export interface RememberProofInput {
  /** The proof's `jti` claim. */
  jti: string;
  /** Thumbprint of the proof key, scoping the `jti` to one client. */
  jkt: string;
  /** Overrides the store's default proof lifetime. */
  ttlMs?: number;
}

export interface ReplayStore {
  /** Mints a nonce and records it as redeemable exactly once. */
  issueNonce(): Promise<NonceIssue>;
  /** Redeems an issued nonce. Atomic, so a concurrent second attempt loses. */
  consumeNonce(value: string): Promise<ReplayCheck>;
  /** Claims a `jti` for its acceptance window. A second claim is a replay. */
  rememberProof(input: RememberProofInput): Promise<ReplayCheck>;
}

/**
 * Redis-backed single-use storage for nonces and DPoP proof identifiers.
 *
 * `@mita/core` verifies a proof's signature and claims but deliberately performs no
 * replay detection, because it does no I/O. This is the missing half: without it, the
 * same valid proof can be presented indefinitely.
 *
 * Every failure here denies the request. Unlike rate limiting — which protects
 * availability and so fails open — replay protection is a correctness property, and an
 * unreachable Redis must never be allowed to widen the replay window.
 */
export function createReplayStore(options: CreateReplayStoreOptions): ReplayStore {
  const {
    redis,
    prefix = DEFAULT_REPLAY_STORE_PREFIX,
    nonceTtlMs = DEFAULT_NONCE_TTL_MS,
    proofTtlMs = DEFAULT_PROOF_TTL_MS,
    timeoutMs = DEFAULT_REPLAY_STORE_TIMEOUT_MS,
    onUnavailable,
  } = options;

  const unavailable = (cause: unknown) => {
    onUnavailable?.(cause);
    return { ok: false, reason: 'unavailable', cause } as const;
  };

  return {
    async issueNonce() {
      const nonce = createNonce({ ttlMs: nonceTtlMs });

      try {
        await withTimeout(
          redis.set(`${prefix}:nonce:${nonce.value}`, 1, { px: nonceTtlMs }),
          timeoutMs,
        );

        return { ok: true, nonce };
      } catch (cause) {
        return unavailable(cause);
      }
    },

    async consumeNonce(value) {
      if (!nonceSchema.safeParse(value).success) {
        return { ok: false, reason: 'unknown_nonce' };
      }

      try {
        // GETDEL reads and deletes in one command, so two concurrent redemptions of the
        // same nonce cannot both observe it as present.
        const stored = await withTimeout(redis.getdel(`${prefix}:nonce:${value}`), timeoutMs);

        return stored === null ? { ok: false, reason: 'unknown_nonce' } : { ok: true };
      } catch (cause) {
        return unavailable(cause);
      }
    },

    async rememberProof({ jti, jkt, ttlMs = proofTtlMs }) {
      try {
        // SET NX is the atomic claim: whoever writes the key first owns that jti, and
        // every later proof carrying it is a replay.
        const claimed = await withTimeout(
          redis.set(`${prefix}:jti:${jkt}:${jti}`, 1, { nx: true, px: ttlMs }),
          timeoutMs,
        );

        return claimed === null ? { ok: false, reason: 'replayed' } : { ok: true };
      } catch (cause) {
        return unavailable(cause);
      }
    },
  };
}

/**
 * Caps how long we wait on Redis.
 *
 * `@upstash/redis` exposes no per-command deadline, and its default retry schedule can
 * stretch a single call into double-digit seconds — long enough to hold a request open
 * until the platform kills it.
 */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new MitaError('store.timeout', `Redis did not answer within ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
