import { generateNonce } from '@mita-auth/core';
// The one place this package is allowed to import Zod: a test carries no bundle weight,
// and the whole point here is to hold the hand-written checks against the schemas they
// replaced. If these two ever disagree, the guard has started accepting something the
// protocol says it should not.
import { nonceSchema, turnstileTokenSchema } from '@mita-auth/core/schemas';
import { describe, expect, it } from 'vitest';

import { isWellFormedNonce, isWellFormedTurnstileToken } from './validate';

const NONCES = [
  generateNonce(),
  generateNonce({ bytes: 16 }),
  generateNonce({ bytes: 256 }),
  '',
  'a',
  'a'.repeat(21),
  'a'.repeat(22),
  'a'.repeat(342),
  'a'.repeat(343),
  'not base64url!',
  'has spaces here now',
  'contains+slash/and=pad',
  'ünïcödé-nonce-value-here',
];

const TOKENS = ['', '0.abc-def', 'x', 'a'.repeat(2048), 'a'.repeat(2049), '\n', '0.'.repeat(500)];

describe('isWellFormedNonce', () => {
  it.each(NONCES)('agrees with nonceSchema on %j', (value) => {
    expect(isWellFormedNonce(value)).toBe(nonceSchema.safeParse(value).success);
  });

  it('accepts what generateNonce produces at every supported size', () => {
    for (let bytes = 16; bytes <= 256; bytes += 16) {
      expect(isWellFormedNonce(generateNonce({ bytes }))).toBe(true);
    }
  });
});

describe('isWellFormedTurnstileToken', () => {
  it.each(TOKENS)('agrees with turnstileTokenSchema on %j', (token) => {
    expect(isWellFormedTurnstileToken(token)).toBe(turnstileTokenSchema.safeParse(token).success);
  });
});
