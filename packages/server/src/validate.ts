/**
 * The two shape checks the guard path performs, written without Zod.
 *
 * `@mita-auth/core/schemas` states the same two rules, and stating them twice is a real
 * cost — `validate.test.ts` pins the two forms together for that reason. What it buys is
 * the whole of Zod staying out of the guard: importing a schema here put 17 Zod modules
 * and 40% of a Worker bundle into every cold start, to decide five booleans. Neither call
 * site ever wanted more than `.success`.
 *
 * The bounds themselves are not restated — they come from `@mita-auth/core`, which reaches
 * no further than `patterns.ts` and `nonce.ts` for them.
 */
import {
  BASE64URL_PATTERN,
  MAX_NONCE_BYTES,
  MAX_TURNSTILE_TOKEN_LENGTH,
  MIN_NONCE_BYTES,
} from '@mita-auth/core';

/** base64url spends 4 characters per 3 bytes. */
const base64urlLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

const MIN_NONCE_LENGTH = base64urlLength(MIN_NONCE_BYTES);
const MAX_NONCE_LENGTH = base64urlLength(MAX_NONCE_BYTES);

/**
 * Whether a value could be a nonce this server issued.
 *
 * A store consults this before Redis: a value that cannot be one of ours is an unknown
 * nonce whatever the store says, and rejecting it here spends no round trip.
 */
export function isWellFormedNonce(value: string): boolean {
  return (
    value.length >= MIN_NONCE_LENGTH &&
    value.length <= MAX_NONCE_LENGTH &&
    BASE64URL_PATTERN.test(value)
  );
}

/** Whether a token is worth spending a siteverify round trip on. */
export function isWellFormedTurnstileToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TURNSTILE_TOKEN_LENGTH;
}
