/**
 * In-process stand-ins for the two stores the guard needs, so that a project can install
 * Mita and have it work before it has an Upstash account.
 *
 * **Single process only, and not durable.** Every counter and every spent nonce lives in one
 * instance's memory: a second instance shares nothing with the first, and a restart — or a
 * cold start, which on Edge is most requests — forgets everything. That makes the rate limit
 * divisible by the number of instances, and it makes a spent nonce redeemable again once the
 * instance that spent it is gone. Neither is acceptable in production.
 *
 * They live behind their own entry point for that reason. `@mita-auth/server/memory` is one
 * import line to spot in review, and one thing to grep for before a deploy.
 */
import { MitaError, createNonce } from '@mita-auth/core';
import { nonceSchema } from '@mita-auth/core/schemas';
import type { Duration } from '@upstash/ratelimit';

import {
  DEFAULT_RATE_LIMIT_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW,
  UNIDENTIFIED_RATE_LIMIT_KEY,
  resolveClientIp,
  type RateLimitDecision,
  type RateLimiter,
} from './ratelimit';
import {
  DEFAULT_NONCE_TTL_MS,
  DEFAULT_PROOF_TTL_MS,
  type NonceIssue,
  type ReplayCheck,
  type ReplayStore,
} from './replay';

/** Dead entries are swept on write rather than by a timer, which Edge would not keep alive. */
const SWEEP_INTERVAL_WRITES = 256;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export interface CreateMemoryReplayStoreOptions {
  /** Lifetime of an issued nonce. Defaults to 5 minutes. */
  nonceTtlMs?: number;
  /** Lifetime of a remembered `jti`. Defaults to 70 seconds. */
  proofTtlMs?: number;
  /** Current time in epoch milliseconds. Injected by tests. */
  now?: () => number;
}

export interface CreateMemoryRateLimiterOptions {
  /** Requests allowed per window. Defaults to 10. */
  requests?: number;
  /** Window length, e.g. `'1 m'` or `'10 s'`. Defaults to `'1 m'`. */
  window?: Duration;
  /**
   * Derives the bucket key from the request. Anything unusable — `null`, `undefined` or an
   * empty string — falls back to {@link UNIDENTIFIED_RATE_LIMIT_KEY}.
   */
  identifier?: (request: Request) => string | null | undefined;
  /** Current time in epoch milliseconds. Injected by tests. */
  now?: () => number;
}

/**
 * A {@link ReplayStore} held in one process's memory.
 *
 * Single use is enforced the way the Redis store enforces it — a redemption deletes, a claim
 * refuses to overwrite — and that is exact here rather than merely likely: JavaScript runs
 * one turn at a time, so nothing can interleave between the read and the write.
 */
export function createMemoryReplayStore(options: CreateMemoryReplayStoreOptions = {}): ReplayStore {
  const {
    nonceTtlMs = DEFAULT_NONCE_TTL_MS,
    proofTtlMs = DEFAULT_PROOF_TTL_MS,
    now = Date.now,
  } = options;

  const nonces = createExpiringKeys(now);
  const proofs = createExpiringKeys(now);

  return {
    issueNonce() {
      const nonce = createNonce({ ttlMs: nonceTtlMs, now: now() });

      nonces.claim(nonce.value, nonceTtlMs);

      return Promise.resolve<NonceIssue>({ ok: true, nonce });
    },

    consumeNonce(value) {
      if (!nonceSchema.safeParse(value).success) {
        return Promise.resolve<ReplayCheck>({ ok: false, reason: 'unknown_nonce' });
      }

      return Promise.resolve<ReplayCheck>(
        nonces.redeem(value) ? { ok: true } : { ok: false, reason: 'unknown_nonce' },
      );
    },

    rememberProof({ jti, jkt, ttlMs = proofTtlMs }) {
      // Scoped by `jkt` for the reason the Redis store scopes it: one client's choice of
      // `jti` must not be able to lock another client out of its own.
      return Promise.resolve<ReplayCheck>(
        proofs.claim(`${jkt}:${jti}`, ttlMs) ? { ok: true } : { ok: false, reason: 'replayed' },
      );
    },
  };
}

/**
 * A {@link RateLimiter} held in one process's memory.
 *
 * The algorithm is the sliding window Upstash's own limiter uses: the current window's count
 * plus the previous one's, weighted by how far into the current window we are. A plain fixed
 * window would let twice the limit through either side of a boundary.
 *
 * `degraded` is always false and `pending` always resolved — there is nothing here that can
 * be unavailable, and nothing owed in the background.
 */
export function createMemoryRateLimiter(options: CreateMemoryRateLimiterOptions = {}): RateLimiter {
  const {
    requests = DEFAULT_RATE_LIMIT_REQUESTS,
    window = DEFAULT_RATE_LIMIT_WINDOW,
    identifier = resolveClientIp,
    now = Date.now,
  } = options;

  const windowMs = parseDuration(window);
  const counts = new Map<string, number>();
  let writes = 0;

  /** Only the current window and the one before it are ever read again. */
  const prune = (currentWindow: number): void => {
    writes += 1;

    if (writes % SWEEP_INTERVAL_WRITES !== 0) {
      return;
    }

    for (const key of counts.keys()) {
      if (Number(key.slice(key.lastIndexOf(':') + 1)) < currentWindow - 1) {
        counts.delete(key);
      }
    }
  };

  return {
    limit(request) {
      const candidate = identifier(request);
      // Not `??`: an identifier that returns `''` would otherwise build a key ending in a
      // colon, which behaves like a shared bucket without ever having been called one.
      const key =
        candidate === null || candidate === undefined || candidate === ''
          ? UNIDENTIFIED_RATE_LIMIT_KEY
          : candidate;

      const at = now();
      const currentWindow = Math.floor(at / windowMs);
      const currentKey = `${key}:${currentWindow}`;

      const current = counts.get(currentKey) ?? 0;
      const elapsed = (at % windowMs) / windowMs;
      const carried = Math.floor((1 - elapsed) * (counts.get(`${key}:${currentWindow - 1}`) ?? 0));
      const used = current + carried;

      const decision = (success: boolean, remaining: number): RateLimitDecision => ({
        success,
        identifier: key,
        limit: requests,
        remaining,
        reset: (currentWindow + 1) * windowMs,
        degraded: false,
        pending: Promise.resolve(),
      });

      if (used >= requests) {
        return Promise.resolve(decision(false, 0));
      }

      counts.set(currentKey, current + 1);
      prune(currentWindow);

      return Promise.resolve(decision(true, requests - used - 1));
    },
  };
}

interface ExpiringKeys {
  /** Records `key` for `ttlMs` unless it is already held. Returns whether it was taken. */
  claim(key: string, ttlMs: number): boolean;
  /** Takes `key` out, returning whether it was still there. */
  redeem(key: string): boolean;
}

/**
 * Keys that disappear once their time is up.
 *
 * Expiry is lazy, as it is in Redis — a read is where a dead key goes — and a periodic sweep
 * on write keeps the map from growing without bound. A timer per key would be the obvious
 * alternative and is the wrong one: it would outlive the request that created it, and Edge
 * runtimes stop the clock between requests anyway.
 */
function createExpiringKeys(now: () => number): ExpiringKeys {
  const expiries = new Map<string, number>();
  let writes = 0;

  const live = (key: string): boolean => {
    const expiresAt = expiries.get(key);

    if (expiresAt === undefined) {
      return false;
    }

    if (expiresAt <= now()) {
      expiries.delete(key);
      return false;
    }

    return true;
  };

  const sweep = (): void => {
    writes += 1;

    if (writes % SWEEP_INTERVAL_WRITES !== 0) {
      return;
    }

    const cutoff = now();

    for (const [key, expiresAt] of expiries) {
      if (expiresAt <= cutoff) {
        expiries.delete(key);
      }
    }
  };

  return {
    claim(key, ttlMs) {
      if (live(key)) {
        return false;
      }

      expiries.set(key, now() + ttlMs);
      sweep();

      return true;
    },

    redeem(key) {
      if (!live(key)) {
        return false;
      }

      expiries.delete(key);

      return true;
    },
  };
}

/** Accepts both spellings `@upstash/ratelimit` accepts: `'1 m'` and `'1m'`. */
function parseDuration(window: Duration): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(window);
  const unit = match?.[2];
  const size = match === null || unit === undefined ? 0 : Number(match[1]) * (UNIT_MS[unit] ?? 0);

  if (size <= 0) {
    throw new MitaError(
      'config.invalid_rate_limit_window',
      `Rate limit window must be a positive duration such as "1 m" or "10s", received ${JSON.stringify(window)}.`,
    );
  }

  return size;
}
