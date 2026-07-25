import { describe, expect, it } from 'vitest';

import { MitaError } from './errors';
import {
  DEFAULT_NONCE_BYTES,
  MAX_NONCE_BYTES,
  MIN_NONCE_BYTES,
  createNonce,
  generateNonce,
  isNonceExpired,
  timingSafeEqual,
} from './nonce';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const base64urlLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('generateNonce', () => {
  it('encodes the default entropy as base64url without padding', () => {
    const nonce = generateNonce();

    expect(nonce).toMatch(BASE64URL);
    expect(nonce).toHaveLength(base64urlLength(DEFAULT_NONCE_BYTES));
  });

  it('honours a custom entropy size', () => {
    expect(generateNonce({ bytes: MIN_NONCE_BYTES })).toHaveLength(base64urlLength(MIN_NONCE_BYTES));
    expect(generateNonce({ bytes: MAX_NONCE_BYTES })).toHaveLength(base64urlLength(MAX_NONCE_BYTES));
  });

  it('produces unique values across a large sample', () => {
    const samples = new Set<string>();

    for (let index = 0; index < 100_000; index += 1) {
      samples.add(generateNonce());
    }

    expect(samples.size).toBe(100_000);
  });

  const invalidSizes: [label: string, bytes: number][] = [
    ['below the minimum', MIN_NONCE_BYTES - 1],
    ['above the maximum', MAX_NONCE_BYTES + 1],
    ['fractional', 32.5],
    ['not a number', Number.NaN],
  ];

  it.each(invalidSizes)('rejects an entropy size that is %s', (_label, bytes) => {
    expect(thrown(() => generateNonce({ bytes }))).toMatchObject({
      code: 'config.invalid_nonce_size',
    });
  });

  it('throws a MitaError so callers can branch on the class', () => {
    expect(() => generateNonce({ bytes: 0 })).toThrowError(MitaError);
  });
});

describe('createNonce', () => {
  it('omits an expiry when no TTL is given', () => {
    const nonce = createNonce({ now: 1_000 });

    expect(nonce.value).toMatch(BASE64URL);
    expect(nonce.issuedAt).toBe(1_000);
    expect(nonce.expiresAt).toBeNull();
  });

  it('derives the expiry from the TTL', () => {
    expect(createNonce({ ttlMs: 300_000, now: 1_000 }).expiresAt).toBe(301_000);
  });

  it('forwards the entropy size', () => {
    expect(createNonce({ bytes: MIN_NONCE_BYTES }).value).toHaveLength(
      base64urlLength(MIN_NONCE_BYTES),
    );
  });

  it.each([0, -1, Number.POSITIVE_INFINITY])('rejects a TTL of %s', (ttlMs) => {
    expect(thrown(() => createNonce({ ttlMs }))).toMatchObject({
      code: 'config.invalid_nonce_ttl',
    });
  });
});

describe('isNonceExpired', () => {
  const nonce = createNonce({ ttlMs: 1_000, now: 0 });

  it('is false before the expiry', () => {
    expect(isNonceExpired(nonce, 999)).toBe(false);
  });

  it('is true at and after the expiry', () => {
    expect(isNonceExpired(nonce, 1_000)).toBe(true);
    expect(isNonceExpired(nonce, 5_000)).toBe(true);
  });

  it('never expires a nonce without a TTL', () => {
    expect(isNonceExpired(createNonce({ now: 0 }), Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('rejects differing strings', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abcde')).toBe(false);
    expect(timingSafeEqual('abc', '')).toBe(false);
  });
});
