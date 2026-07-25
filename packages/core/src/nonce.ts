import { base64url } from 'jose';

import { MitaError } from './errors';
import { getWebCrypto } from './internal/webcrypto';

export const DEFAULT_NONCE_BYTES = 32;
export const MIN_NONCE_BYTES = 16;
export const MAX_NONCE_BYTES = 256;

export interface GenerateNonceOptions {
  /** Entropy in bytes. Defaults to 32 (a 43-character base64url string). */
  bytes?: number;
}

export interface CreateNonceOptions extends GenerateNonceOptions {
  /** Lifetime in milliseconds. Omit for a nonce without an expiry. */
  ttlMs?: number;
  /** Current time in epoch milliseconds. Injected by tests. */
  now?: number;
}

/**
 * An opaque nonce plus its TTL metadata.
 *
 * The value carries no embedded timestamp and is not signed — expiry and single-use
 * semantics both live in the server-side store (`@mita-auth/server` writes it to Upstash Redis
 * with `SET NX PX`). Keeping the value opaque means a client can never influence its own
 * validity window.
 */
export interface Nonce {
  readonly value: string;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
}

/**
 * Generates a cryptographically random, base64url-encoded nonce.
 *
 * Used for two distinct purposes that share this one source of randomness:
 * the server-issued freshness challenge (`DPoP-Nonce`, echoed as the proof's `nonce`
 * claim) and the client-generated per-proof identifier (`jti`, deduplicated by the
 * server to block replays). They are never the same value.
 */
export function generateNonce(options: GenerateNonceOptions = {}): string {
  const { bytes = DEFAULT_NONCE_BYTES } = options;

  if (!Number.isInteger(bytes) || bytes < MIN_NONCE_BYTES || bytes > MAX_NONCE_BYTES) {
    throw new MitaError(
      'config.invalid_nonce_size',
      `Nonce size must be an integer between ${MIN_NONCE_BYTES} and ${MAX_NONCE_BYTES} bytes, received ${String(bytes)}.`,
    );
  }

  return base64url.encode(getWebCrypto().getRandomValues(new Uint8Array(bytes)));
}

/** Generates a nonce alongside the TTL metadata a store needs to expire it. */
export function createNonce(options: CreateNonceOptions = {}): Nonce {
  const { ttlMs, now = Date.now(), ...generateOptions } = options;

  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new MitaError(
      'config.invalid_nonce_ttl',
      `Nonce TTL must be a positive number of milliseconds, received ${String(ttlMs)}.`,
    );
  }

  return {
    value: generateNonce(generateOptions),
    issuedAt: now,
    expiresAt: ttlMs === undefined ? null : now + ttlMs,
  };
}

export function isNonceExpired(nonce: Nonce, now: number = Date.now()): boolean {
  return nonce.expiresAt !== null && now >= nonce.expiresAt;
}

/**
 * Compares two strings without leaking their common prefix length through timing.
 *
 * Length itself is not secret here (nonces are fixed-width), so an early length check is
 * acceptable; the character comparison never short-circuits.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}
