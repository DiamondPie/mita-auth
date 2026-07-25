import { afterEach, describe, expect, it, vi } from 'vitest';

import { getWebCrypto, sha256 } from './webcrypto';

afterEach(() => {
  vi.unstubAllGlobals();
});

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('getWebCrypto', () => {
  it('returns the global implementation when it is complete', () => {
    expect(getWebCrypto()).toBe(globalThis.crypto);
  });

  it.each([
    ['no crypto global at all', undefined],
    ['a crypto global without getRandomValues', { subtle: {} }],
    ['a crypto global without subtle', { getRandomValues: () => new Uint8Array() }],
  ])('throws on %s', (_label, stub) => {
    vi.stubGlobal('crypto', stub);

    expect(thrown(() => getWebCrypto())).toMatchObject({
      code: 'runtime.webcrypto_unavailable',
    });
  });
});

describe('sha256', () => {
  it('produces the 32-byte digest of the UTF-8 encoding', async () => {
    const digest = await sha256('abc');

    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest).toHaveLength(32);
    // Well-known SHA-256("abc") prefix.
    expect(Array.from(digest.slice(0, 4))).toEqual([0xba, 0x78, 0x16, 0xbf]);
  });

  it('is stable and input-sensitive', async () => {
    expect(await sha256('abc')).toEqual(await sha256('abc'));
    expect(await sha256('abc')).not.toEqual(await sha256('abd'));
  });
});
