import { describe, expect, it } from 'vitest';

import { generateNonce } from './nonce';
import { COMPACT_JWT_PATTERN, MAX_DPOP_PROOF_LENGTH } from './patterns';
import {
  commentSchema,
  createCommentSchema,
  dpopProofSchema,
  jwkThumbprintSchema,
  nonceSchema,
  securityEnvelopeSchema,
  turnstileTokenSchema,
} from './schemas';

const compactJwt = 'eyJhbGciOiJFUzI1NiJ9.eyJqdGkiOiJhIn0.c2lnbmF0dXJl';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('nonceSchema', () => {
  it('accepts what generateNonce produces', () => {
    expect(nonceSchema.safeParse(generateNonce()).success).toBe(true);
    expect(nonceSchema.safeParse(generateNonce({ bytes: 16 })).success).toBe(true);
    expect(nonceSchema.safeParse(generateNonce({ bytes: 256 })).success).toBe(true);
  });

  it.each([
    ['too short', 'short'],
    ['padded base64', 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODk='],
    ['non-base64url characters', 'abc$def/ghi+jkl mno pqr stu vwx yz0 123 456 789'],
    ['empty', ''],
  ])('rejects a nonce that is %s', (_label, value) => {
    expect(nonceSchema.safeParse(value).success).toBe(false);
  });
});

describe('jwkThumbprintSchema', () => {
  it('accepts a 43-character base64url digest', () => {
    expect(jwkThumbprintSchema.safeParse('a'.repeat(43)).success).toBe(true);
  });

  it('rejects any other length', () => {
    expect(jwkThumbprintSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(jwkThumbprintSchema.safeParse('a'.repeat(44)).success).toBe(false);
  });
});

describe('dpopProofSchema', () => {
  it('accepts a three-segment compact JWT', () => {
    expect(dpopProofSchema.safeParse(compactJwt).success).toBe(true);
  });

  it('rejects other serializations', () => {
    expect(dpopProofSchema.safeParse('header.payload').success).toBe(false);
    expect(dpopProofSchema.safeParse('a.b.c.d').success).toBe(false);
    expect(dpopProofSchema.safeParse('{"alg":"ES256"}').success).toBe(false);
  });

  it('caps the accepted length', () => {
    expect(dpopProofSchema.safeParse(`a.b.${'c'.repeat(4096)}`).success).toBe(false);
  });

  // `verifyDPoP` cannot use this schema: importing it would put Zod in front of every
  // browser that only signs. It applies the same two constants by hand instead, so a rule
  // added here that is not one of them would leave the two checks quietly disagreeing.
  it.each([
    compactJwt,
    'header.payload',
    'a.b.c.d',
    '',
    'a+b.c.d',
    `a.b.${'c'.repeat(MAX_DPOP_PROOF_LENGTH)}`,
  ])('says about %j exactly what the shared constants say', (proof) => {
    const byHand = proof.length <= MAX_DPOP_PROOF_LENGTH && COMPACT_JWT_PATTERN.test(proof);

    expect(dpopProofSchema.safeParse(proof).success).toBe(byHand);
  });
});

describe('turnstileTokenSchema', () => {
  it('accepts a non-empty token within the Cloudflare cap', () => {
    expect(turnstileTokenSchema.safeParse('0.abc-def').success).toBe(true);
  });

  it('rejects empty and oversized tokens', () => {
    expect(turnstileTokenSchema.safeParse('').success).toBe(false);
    expect(turnstileTokenSchema.safeParse('a'.repeat(2049)).success).toBe(false);
  });
});

describe('securityEnvelopeSchema', () => {
  const nonce = generateNonce();

  it('requires a nonce and leaves the rest optional', () => {
    expect(securityEnvelopeSchema.safeParse({ nonce }).success).toBe(true);
    expect(securityEnvelopeSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(securityEnvelopeSchema.safeParse({ nonce, captcha: 'x' }).success).toBe(false);
  });

  it('can be tightened with Zod combinators', () => {
    const strict = securityEnvelopeSchema.required({ turnstileToken: true });

    expect(strict.safeParse({ nonce }).success).toBe(false);
    expect(strict.safeParse({ nonce, turnstileToken: '0.abc' }).success).toBe(true);
  });
});

describe('commentSchema', () => {
  it('trims content and keeps the trimmed value', () => {
    const result = commentSchema.parse({ content: '  hello  ' });

    expect(result.content).toBe('hello');
  });

  it('rejects blank and oversized content', () => {
    expect(commentSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(commentSchema.safeParse({ content: 'a'.repeat(5001) }).success).toBe(false);
  });

  it('allows tab, newline and carriage return but no other control characters', () => {
    expect(commentSchema.safeParse({ content: 'line\tone\r\nline two' }).success).toBe(true);
    expect(commentSchema.safeParse({ content: 'null byte \u0000' }).success).toBe(false);
    expect(commentSchema.safeParse({ content: 'bell \u0007' }).success).toBe(false);
    expect(commentSchema.safeParse({ content: 'delete \u007f' }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(commentSchema.safeParse({ content: 'hi', isAdmin: true }).success).toBe(false);
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg/onload=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ])('accepts %s as plain text, leaving markup removal to the sanitizer', (payload) => {
    expect(commentSchema.safeParse({ content: payload }).success).toBe(true);
  });

  it('validates the author email', () => {
    expect(commentSchema.safeParse({ content: 'hi', email: 'a@example.com' }).success).toBe(true);
    expect(commentSchema.safeParse({ content: 'hi', email: 'not-an-email' }).success).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd'])(
    'rejects %s as an author URL',
    (url) => {
      expect(commentSchema.safeParse({ content: 'hi', url }).success).toBe(false);
    },
  );

  it('accepts http and https author URLs', () => {
    expect(commentSchema.safeParse({ content: 'hi', url: 'https://example.com' }).success).toBe(
      true,
    );
    expect(commentSchema.safeParse({ content: 'hi', url: 'http://example.com' }).success).toBe(true);
  });

  it('constrains the parent comment id', () => {
    expect(commentSchema.safeParse({ content: 'hi', parentId: 'abc-123_XYZ' }).success).toBe(true);
    expect(commentSchema.safeParse({ content: 'hi', parentId: 'a'.repeat(65) }).success).toBe(false);
    expect(commentSchema.safeParse({ content: 'hi', parentId: '../../etc' }).success).toBe(false);
  });

  it('composes with Zod combinators instead of extra options', () => {
    const schema = commentSchema.required({ author: true }).extend({ postId: nonceSchema });

    expect(schema.safeParse({ content: 'hi', postId: generateNonce() }).success).toBe(false);
    expect(
      schema.safeParse({ content: 'hi', author: 'Ada', postId: generateNonce() }).success,
    ).toBe(true);
  });
});

describe('createCommentSchema', () => {
  it('applies custom length limits', () => {
    const schema = createCommentSchema({ minContentLength: 5, maxContentLength: 10 });

    expect(schema.safeParse({ content: 'four' }).success).toBe(false);
    expect(schema.safeParse({ content: 'a'.repeat(11) }).success).toBe(false);
    expect(schema.safeParse({ content: 'five!' }).success).toBe(true);
    expect(schema.safeParse({ content: 'a'.repeat(10) }).success).toBe(true);
  });

  it('applies a custom URL protocol allowlist', () => {
    const schema = createCommentSchema({ allowedUrlProtocols: ['https'] });

    expect(schema.safeParse({ content: 'hi', url: 'https://example.com' }).success).toBe(true);
    expect(schema.safeParse({ content: 'hi', url: 'http://example.com' }).success).toBe(false);
  });

  it('tolerates protocols written with a trailing colon', () => {
    const schema = createCommentSchema({ allowedUrlProtocols: ['https:'] });

    expect(schema.safeParse({ content: 'hi', url: 'https://example.com' }).success).toBe(true);
  });

  const invalidProtocolLists: [label: string, protocols: string[]][] = [
    ['an empty allowlist', []],
    ['a scheme with spaces', ['not a scheme']],
    ['a full URL instead of a scheme', ['javascript:alert(1)']],
  ];

  it.each(invalidProtocolLists)('rejects %s', (_label, allowedUrlProtocols) => {
    expect(thrown(() => createCommentSchema({ allowedUrlProtocols }))).toMatchObject({
      code: 'config.invalid_url_protocol',
    });
  });
});
