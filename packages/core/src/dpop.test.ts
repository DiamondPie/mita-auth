import {
  SignJWT,
  base64url,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  type JWTHeaderParameters,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_DPOP_ALGORITHM,
  DPOP_JWT_TYPE,
  SUPPORTED_DPOP_ALGORITHMS,
  calculateJkt,
  exportDPoPKeyPair,
  generateDPoPKeyPair,
  importDPoPKeyPair,
  signDPoP,
  verifyDPoP,
  type DPoPAlgorithm,
  type DPoPKeyPair,
} from './dpop';
import { DPoPVerificationError } from './errors';
import { generateNonce } from './nonce';

const METHOD = 'POST';
const URL_UNDER_TEST = 'https://api.example.com/comments';
const NOW = 1_800_000_000_000;
const NOW_SECONDS = NOW / 1000;

let keyPair: DPoPKeyPair;
let extractableKeyPair: DPoPKeyPair;

beforeAll(async () => {
  keyPair = await generateDPoPKeyPair();
  extractableKeyPair = await generateDPoPKeyPair({ extractable: true });
});

const sign = (overrides: Partial<Parameters<typeof signDPoP>[1]> = {}, pair = keyPair) =>
  signDPoP(pair, { method: METHOD, url: URL_UNDER_TEST, issuedAt: NOW_SECONDS, ...overrides });

const verify = (proof: string, overrides: Partial<Parameters<typeof verifyDPoP>[1]> = {}) =>
  verifyDPoP(proof, { method: METHOD, url: URL_UNDER_TEST, now: NOW, ...overrides });

/** Builds a proof with a hand-written protected header, bypassing signDPoP's guarantees. */
const craft = (header: Record<string, unknown>, claims: Record<string, unknown> = {}) =>
  new SignJWT({ htm: METHOD, htu: URL_UNDER_TEST, ...claims })
    .setProtectedHeader(header as unknown as JWTHeaderParameters)
    .setIssuedAt(NOW_SECONDS)
    .setJti(generateNonce())
    .sign(keyPair.privateKey);

describe('generateDPoPKeyPair', () => {
  it('defaults to ES256 with a non-extractable private key', async () => {
    const pair = await generateDPoPKeyPair();

    expect(pair.algorithm).toBe(DEFAULT_DPOP_ALGORITHM);
    expect(pair.privateKey.extractable).toBe(false);
  });

  it('leaves the public key extractable so it can be embedded in the proof header', () => {
    expect(keyPair.publicKey.extractable).toBe(true);
  });

  it('rejects an algorithm outside the allowlist', async () => {
    await expect(
      generateDPoPKeyPair({ algorithm: 'HS256' as DPoPAlgorithm }),
    ).rejects.toMatchObject({ code: 'config.unsupported_algorithm' });
  });
});

describe('exportDPoPKeyPair / importDPoPKeyPair', () => {
  it('refuses to export a non-extractable private key', async () => {
    await expect(exportDPoPKeyPair(keyPair)).rejects.toMatchObject({
      code: 'config.key_not_extractable',
    });
  });

  it('round-trips an extractable key pair', async () => {
    const exported = await exportDPoPKeyPair(extractableKeyPair);
    const imported = await importDPoPKeyPair(exported);

    expect(exported.privateKey).toHaveProperty('d');
    expect(exported.publicKey).not.toHaveProperty('d');
    expect(await calculateJkt(imported.publicKey)).toBe(
      await calculateJkt(extractableKeyPair.publicKey),
    );
  });

  it('produces a key pair that still signs verifiable proofs', async () => {
    const imported = await importDPoPKeyPair(await exportDPoPKeyPair(extractableKeyPair));
    const proof = await sign({}, imported);

    await expect(verify(proof)).resolves.toMatchObject({ htm: METHOD });
  });

  it('rejects an algorithm outside the allowlist', async () => {
    const exported = await exportDPoPKeyPair(extractableKeyPair);

    await expect(
      importDPoPKeyPair({ ...exported, algorithm: 'HS256' as DPoPAlgorithm }),
    ).rejects.toMatchObject({ code: 'config.unsupported_algorithm' });
  });
});

describe('calculateJkt', () => {
  it('is a 43-character base64url digest', async () => {
    expect(await calculateJkt(keyPair.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is stable for one key and distinct across keys', async () => {
    const jkt = await calculateJkt(keyPair.publicKey);

    expect(await calculateJkt(keyPair.publicKey)).toBe(jkt);
    expect(await calculateJkt(extractableKeyPair.publicKey)).not.toBe(jkt);
  });
});

describe('signDPoP', () => {
  it('emits a proof carrying the DPoP type and embedded public key', async () => {
    const header = decodeProtectedHeader(await sign());

    expect(header.typ).toBe(DPOP_JWT_TYPE);
    expect(header.alg).toBe('ES256');
    expect(header.jwk).toEqual(await exportJWK(keyPair.publicKey));
    expect(header.jwk).not.toHaveProperty('d');
  });

  it('generates a fresh jti per proof', async () => {
    const [first, second] = await Promise.all([verify(await sign()), verify(await sign())]);

    expect(first.jti).not.toBe(second.jti);
  });

  it('rejects a URL that is not absolute', async () => {
    await expect(sign({ url: '/comments' })).rejects.toMatchObject({
      code: 'config.invalid_url',
    });
  });
});

describe('verifyDPoP', () => {
  it.each(SUPPORTED_DPOP_ALGORITHMS)('accepts a proof signed with %s', async (algorithm) => {
    const pair = await generateDPoPKeyPair({ algorithm });
    const proof = await sign({}, pair);

    await expect(verify(proof)).resolves.toMatchObject({
      htm: METHOD,
      htu: URL_UNDER_TEST,
      issuedAt: NOW_SECONDS,
      jkt: await calculateJkt(pair.publicKey),
    });
  });

  it('ignores query and fragment when binding the URL', async () => {
    const proof = await sign({ url: `${URL_UNDER_TEST}?page=2#top` });

    await expect(verify(proof, { url: `${URL_UNDER_TEST}?other=1` })).resolves.toMatchObject({
      htu: URL_UNDER_TEST,
    });
  });

  it('accepts the same proof twice, leaving replay detection to the caller', async () => {
    const proof = await sign();

    const first = await verify(proof);
    const second = await verify(proof);

    expect(second.jti).toBe(first.jti);
  });

  it('rejects a proof whose payload was tampered with', async () => {
    const proof = await sign();
    const [header, , signature] = proof.split('.');
    const claims = { ...decodeJwt(proof), jti: generateNonce() };
    const tampered = [header, base64url.encode(JSON.stringify(claims)), signature].join('.');

    await expect(verify(tampered)).rejects.toMatchObject({ code: 'dpop.invalid_signature' });
  });

  it('rejects a proof bound to another method', async () => {
    await expect(verify(await sign(), { method: 'GET' })).rejects.toMatchObject({
      code: 'dpop.htm_mismatch',
    });
  });

  it('rejects a proof bound to another URL', async () => {
    await expect(
      verify(await sign(), { url: 'https://api.example.com/other' }),
    ).rejects.toMatchObject({ code: 'dpop.htu_mismatch' });
  });

  it('rejects a proof older than the acceptance window', async () => {
    const proof = await sign({ issuedAt: NOW_SECONDS - 120 });

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.expired' });
    await expect(verify(proof, { maxAgeSeconds: 300 })).resolves.toBeDefined();
  });

  it('rejects a proof issued in the future beyond the clock tolerance', async () => {
    await expect(verify(await sign({ issuedAt: NOW_SECONDS + 120 }))).rejects.toMatchObject({
      code: 'dpop.issued_in_future',
    });
    await expect(verify(await sign({ issuedAt: NOW_SECONDS + 5 }))).resolves.toBeDefined();
  });

  it('rejects an algorithm excluded by the caller', async () => {
    await expect(verify(await sign(), { algorithms: ['ES384'] })).rejects.toMatchObject({
      code: 'dpop.unsupported_algorithm',
    });
  });

  it.each([
    ['not a jwt', 'dpop.malformed'],
    ['a.b', 'dpop.malformed'],
    ['', 'dpop.malformed'],
  ])('rejects the malformed proof %j', async (proof, code) => {
    await expect(verify(proof)).rejects.toMatchObject({ code });
  });

  it('throws a DPoPVerificationError so callers can branch on the class', async () => {
    await expect(verify('not a jwt')).rejects.toBeInstanceOf(DPoPVerificationError);
  });
});

describe('verifyDPoP header checks', () => {
  it('rejects a proof that is not typed as dpop+jwt', async () => {
    const proof = await craft({ alg: 'ES256', typ: 'JWT', jwk: await exportJWK(keyPair.publicKey) });

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.invalid_type' });
  });

  it('rejects a proof without an embedded public key', async () => {
    const proof = await craft({ alg: 'ES256', typ: DPOP_JWT_TYPE });

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.missing_jwk' });
  });

  it('rejects a proof leaking private key material', async () => {
    const exported = await exportDPoPKeyPair(extractableKeyPair);
    const proof = await craft({ alg: 'ES256', typ: DPOP_JWT_TYPE, jwk: exported.privateKey });

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.private_key_material' });
  });

  it('rejects a proof whose embedded key cannot be imported', async () => {
    const proof = await craft({
      alg: 'ES256',
      typ: DPOP_JWT_TYPE,
      jwk: { kty: 'EC', crv: 'P-256', x: 'not-a-coordinate', y: 'not-a-coordinate' },
    });

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.invalid_key' });
  });

  it('rejects a proof whose key does not match the expected thumbprint', async () => {
    await expect(
      verify(await sign(), { expectedJkt: await calculateJkt(extractableKeyPair.publicKey) }),
    ).rejects.toMatchObject({ code: 'dpop.jkt_mismatch' });
  });

  it('accepts a proof matching the expected thumbprint', async () => {
    await expect(
      verify(await sign(), { expectedJkt: await calculateJkt(keyPair.publicKey) }),
    ).resolves.toBeDefined();
  });
});

describe('verifyDPoP claim checks', () => {
  it('rejects a proof without a usable jti', async () => {
    const proof = await new SignJWT({ htm: METHOD, htu: URL_UNDER_TEST })
      .setProtectedHeader({
        alg: 'ES256',
        typ: DPOP_JWT_TYPE,
        jwk: await exportJWK(keyPair.publicKey),
      })
      .setIssuedAt(NOW_SECONDS)
      .sign(keyPair.privateKey);

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.invalid_jti' });
  });

  it('rejects a proof without a usable iat', async () => {
    const proof = await new SignJWT({ htm: METHOD, htu: URL_UNDER_TEST })
      .setProtectedHeader({
        alg: 'ES256',
        typ: DPOP_JWT_TYPE,
        jwk: await exportJWK(keyPair.publicKey),
      })
      .setJti(generateNonce())
      .sign(keyPair.privateKey);

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.invalid_issued_at' });
  });

  it('rejects a proof whose htu is not a URL at all', async () => {
    const proof = await craft(
      { alg: 'ES256', typ: DPOP_JWT_TYPE, jwk: await exportJWK(keyPair.publicKey) },
      { htu: '/comments' },
    );

    await expect(verify(proof)).rejects.toMatchObject({ code: 'dpop.htu_mismatch' });
  });
});

describe('verifyDPoP access token binding', () => {
  const accessToken = 'at-0123456789';

  it('accepts a proof bound to the presented token', async () => {
    const result = await verify(await sign({ accessToken }), { accessToken });

    expect(result.ath).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a proof bound to a different token', async () => {
    const proof = await sign({ accessToken });

    await expect(verify(proof, { accessToken: 'at-other' })).rejects.toMatchObject({
      code: 'dpop.ath_mismatch',
    });
  });

  it('rejects a bound proof when no token is presented', async () => {
    await expect(verify(await sign({ accessToken }))).rejects.toMatchObject({
      code: 'dpop.ath_mismatch',
    });
  });

  it('rejects an unbound proof when a token is presented', async () => {
    await expect(verify(await sign(), { accessToken })).rejects.toMatchObject({
      code: 'dpop.ath_mismatch',
    });
  });
});

describe('verifyDPoP nonce binding', () => {
  const nonce = generateNonce();

  it('accepts a proof echoing the expected nonce', async () => {
    await expect(verify(await sign({ nonce }), { nonce })).resolves.toMatchObject({ nonce });
  });

  it('rejects a proof echoing a different nonce', async () => {
    await expect(
      verify(await sign({ nonce: generateNonce() }), { nonce }),
    ).rejects.toMatchObject({ code: 'dpop.nonce_mismatch' });
  });

  it('rejects a proof carrying no nonce when one is expected', async () => {
    await expect(verify(await sign(), { nonce })).rejects.toMatchObject({
      code: 'dpop.nonce_mismatch',
    });
  });

  it('returns the nonce unchecked when the caller validates it against its own store', async () => {
    await expect(verify(await sign({ nonce }))).resolves.toMatchObject({ nonce });
  });
});
