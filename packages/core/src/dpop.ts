import {
  SignJWT,
  base64url,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';

import { DPoPVerificationError, MitaError } from './errors';
import { sha256 } from './internal/webcrypto';
import { generateNonce, timingSafeEqual } from './nonce';
import { dpopProofSchema } from './schemas';

/** RFC 9449 §4.2: every DPoP proof carries this `typ` header. */
export const DPOP_JWT_TYPE = 'dpop+jwt';

/**
 * Asymmetric algorithms accepted for DPoP proofs.
 *
 * RFC 9449 rules out symmetric algorithms and `none`; RSASSA-PKCS1-v1_5 (`RS*`) is left
 * out on top of that, since both ends of the wire are Mita and there is no reason to
 * accept the weaker padding.
 */
export const SUPPORTED_DPOP_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
  'Ed25519',
] as const;

export type DPoPAlgorithm = (typeof SUPPORTED_DPOP_ALGORITHMS)[number];

export const DEFAULT_DPOP_ALGORITHM: DPoPAlgorithm = 'ES256';
export const DEFAULT_DPOP_MAX_AGE_SECONDS = 60;
export const DEFAULT_DPOP_CLOCK_TOLERANCE_SECONDS = 5;

export interface DPoPKeyPair {
  readonly algorithm: DPoPAlgorithm;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

/** A key pair in transport form, ready to be persisted as JSON. */
export interface DPoPKeyPairJWK {
  readonly algorithm: DPoPAlgorithm;
  readonly privateKey: JWK;
  readonly publicKey: JWK;
}

export interface GenerateDPoPKeyPairOptions {
  algorithm?: DPoPAlgorithm;
  /**
   * Whether the private key may leave WebCrypto. Defaults to `false` so that a browser
   * key can be stored in IndexedDB without ever being readable by page scripts; set it to
   * `true` only when {@link exportDPoPKeyPair} has to serialize the private key.
   */
  extractable?: boolean;
}

export interface ImportDPoPKeyPairOptions {
  extractable?: boolean;
}

function assertSupportedAlgorithm(algorithm: string): asserts algorithm is DPoPAlgorithm {
  if (!(SUPPORTED_DPOP_ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new MitaError(
      'config.unsupported_algorithm',
      `"${algorithm}" is not a supported DPoP algorithm. Expected one of: ${SUPPORTED_DPOP_ALGORITHMS.join(', ')}.`,
    );
  }
}

export async function generateDPoPKeyPair(
  options: GenerateDPoPKeyPairOptions = {},
): Promise<DPoPKeyPair> {
  const { algorithm = DEFAULT_DPOP_ALGORITHM, extractable = false } = options;
  assertSupportedAlgorithm(algorithm);

  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable });

  return { algorithm, privateKey, publicKey };
}

export async function exportDPoPKeyPair(keyPair: DPoPKeyPair): Promise<DPoPKeyPairJWK> {
  try {
    const [privateKey, publicKey] = await Promise.all([
      exportJWK(keyPair.privateKey),
      exportJWK(keyPair.publicKey),
    ]);

    return { algorithm: keyPair.algorithm, privateKey, publicKey };
  } catch (cause) {
    throw new MitaError(
      'config.key_not_extractable',
      'The private key cannot be exported. Generate it with { extractable: true } if it needs to be persisted.',
      { cause },
    );
  }
}

export async function importDPoPKeyPair(
  exported: DPoPKeyPairJWK,
  options: ImportDPoPKeyPairOptions = {},
): Promise<DPoPKeyPair> {
  const { algorithm } = exported;
  assertSupportedAlgorithm(algorithm);

  const [privateKey, publicKey] = await Promise.all([
    importCryptoKey(exported.privateKey, algorithm, options.extractable),
    importCryptoKey(exported.publicKey, algorithm, options.extractable),
  ]);

  return { algorithm, privateKey, publicKey };
}

async function importCryptoKey(
  jwk: JWK,
  algorithm: DPoPAlgorithm,
  extractable: boolean | undefined,
): Promise<CryptoKey> {
  const key = await importJWK(jwk, algorithm, { extractable });

  if (key instanceof Uint8Array) {
    throw new MitaError(
      'config.symmetric_key',
      'DPoP requires an asymmetric key pair, but the supplied JWK resolved to symmetric key material.',
    );
  }

  return key;
}

/** RFC 7638 SHA-256 JWK thumbprint — the `jkt` an access token is bound to. */
export function calculateJkt(key: CryptoKey | JWK): Promise<string> {
  return calculateJwkThumbprint(key, 'sha256');
}

export interface SignDPoPOptions {
  /** HTTP method of the request the proof is bound to. */
  method: string;
  /** Full request URL. Query and fragment are stripped to form the `htu` claim. */
  url: string | URL;
  /** Server-issued freshness challenge, taken from the `DPoP-Nonce` response header. */
  nonce?: string;
  /** Access token to bind the proof to; hashed into the `ath` claim. */
  accessToken?: string;
  /** Unique proof identifier. Defaults to a fresh random value. */
  jti?: string;
  /** `iat` in epoch seconds. Defaults to now. */
  issuedAt?: number;
}

/**
 * Signs a DPoP proof JWT binding the key pair to one specific request.
 *
 * The `jti` is single-use: the verifier is expected to reject a second proof carrying the
 * same value. That replay store is deliberately not part of `@mita-auth/core` — see
 * {@link verifyDPoP}.
 */
export async function signDPoP(keyPair: DPoPKeyPair, options: SignDPoPOptions): Promise<string> {
  assertSupportedAlgorithm(keyPair.algorithm);

  const publicJwk = await exportJWK(keyPair.publicKey);
  const claims: JWTPayload = {
    htm: options.method.toUpperCase(),
    htu: toHtu(options.url),
  };

  if (options.nonce !== undefined) {
    claims.nonce = options.nonce;
  }

  if (options.accessToken !== undefined) {
    claims.ath = await calculateAth(options.accessToken);
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: keyPair.algorithm, typ: DPOP_JWT_TYPE, jwk: publicJwk })
    .setIssuedAt(options.issuedAt ?? Math.floor(Date.now() / 1000))
    .setJti(options.jti ?? generateNonce())
    .sign(keyPair.privateKey);
}

export interface VerifyDPoPOptions {
  /** HTTP method the proof must be bound to. */
  method: string;
  /** URL the proof must be bound to. Query and fragment are ignored. */
  url: string | URL;
  /**
   * Expected freshness challenge. When omitted, the proof's `nonce` claim is returned
   * unchecked so that the caller can validate it against its own store.
   */
  nonce?: string;
  /** Access token presented with the request; its hash must match the `ath` claim. */
  accessToken?: string;
  /** Thumbprint the proof key must match, e.g. the `jkt` bound to an access token. */
  expectedJkt?: string;
  /** How old a proof may be, in seconds. Defaults to 60. */
  maxAgeSeconds?: number;
  /** Tolerance for clock skew, in seconds. Defaults to 5. */
  clockToleranceSeconds?: number;
  /** Restricts the accepted algorithms further. Defaults to {@link SUPPORTED_DPOP_ALGORITHMS}. */
  algorithms?: readonly DPoPAlgorithm[];
  /** Current time in epoch milliseconds. Injected by tests. */
  now?: number;
}

export interface DPoPProof {
  readonly jti: string;
  readonly htm: string;
  readonly htu: string;
  readonly issuedAt: number;
  /** SHA-256 thumbprint of the proof's public key. */
  readonly jkt: string;
  readonly publicJwk: JWK;
  readonly ath?: string;
  readonly nonce?: string;
}

/**
 * Verifies a DPoP proof against the request it claims to be bound to.
 *
 * Replay detection is out of scope by design: `@mita-auth/core` is a zero-I/O package, so the
 * returned {@link DPoPProof.jti} has to be recorded by the caller — `@mita-auth/server` writes
 * it to Upstash Redis with `SET NX` for the proof's acceptance window. Verifying the same
 * proof twice therefore succeeds here; that is expected, not a gap.
 *
 * @throws {DPoPVerificationError} with a `code` identifying which check failed.
 */
export async function verifyDPoP(proof: string, options: VerifyDPoPOptions): Promise<DPoPProof> {
  const {
    maxAgeSeconds = DEFAULT_DPOP_MAX_AGE_SECONDS,
    clockToleranceSeconds = DEFAULT_DPOP_CLOCK_TOLERANCE_SECONDS,
    algorithms = SUPPORTED_DPOP_ALGORITHMS,
    now = Date.now(),
  } = options;

  if (!dpopProofSchema.safeParse(proof).success) {
    throw new DPoPVerificationError('dpop.malformed', 'DPoP proof is not a compact JWT.');
  }

  const header = decodeHeader(proof);

  if (header.typ !== DPOP_JWT_TYPE) {
    throw new DPoPVerificationError(
      'dpop.invalid_type',
      `DPoP proof must declare typ "${DPOP_JWT_TYPE}".`,
    );
  }

  const algorithm = header.alg;

  if (algorithm === undefined || !(algorithms as readonly string[]).includes(algorithm)) {
    throw new DPoPVerificationError(
      'dpop.unsupported_algorithm',
      `DPoP proof algorithm "${String(algorithm)}" is not accepted.`,
    );
  }

  const publicJwk = readProofJwk(header.jwk);
  const key = await importProofKey(publicJwk, algorithm);
  const payload = await verifySignature(proof, key, algorithm);

  const jti = readStringClaim(payload, 'jti');

  if (jti === undefined || jti.length === 0 || jti.length > 512) {
    throw new DPoPVerificationError('dpop.invalid_jti', 'DPoP proof is missing a usable jti claim.');
  }

  const htm = readStringClaim(payload, 'htm');

  if (htm === undefined || htm.toUpperCase() !== options.method.toUpperCase()) {
    throw new DPoPVerificationError(
      'dpop.htm_mismatch',
      'DPoP proof is not bound to this HTTP method.',
    );
  }

  const htuClaim = readStringClaim(payload, 'htu');
  const htu = htuClaim === undefined ? null : normalizeHtu(htuClaim);

  if (htu === null || htu !== toHtu(options.url)) {
    throw new DPoPVerificationError('dpop.htu_mismatch', 'DPoP proof is not bound to this URL.');
  }

  const issuedAt = payload.iat;

  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    throw new DPoPVerificationError(
      'dpop.invalid_issued_at',
      'DPoP proof is missing a usable iat claim.',
    );
  }

  const nowSeconds = Math.floor(now / 1000);

  if (issuedAt > nowSeconds + clockToleranceSeconds) {
    throw new DPoPVerificationError('dpop.issued_in_future', 'DPoP proof was issued in the future.');
  }

  if (issuedAt < nowSeconds - maxAgeSeconds - clockToleranceSeconds) {
    throw new DPoPVerificationError('dpop.expired', 'DPoP proof is older than the accepted window.');
  }

  const ath = readStringClaim(payload, 'ath');
  await verifyAth(ath, options.accessToken);

  const nonce = readStringClaim(payload, 'nonce');
  const nonceMismatch = nonce === undefined || !timingSafeEqual(nonce, options.nonce ?? '');

  if (options.nonce !== undefined && nonceMismatch) {
    throw new DPoPVerificationError(
      'dpop.nonce_mismatch',
      'DPoP proof does not echo the expected nonce.',
    );
  }

  const jkt = await calculateJkt(publicJwk);

  if (options.expectedJkt !== undefined && !timingSafeEqual(jkt, options.expectedJkt)) {
    throw new DPoPVerificationError(
      'dpop.jkt_mismatch',
      'DPoP proof key does not match the expected thumbprint.',
    );
  }

  return { jti, htm, htu, issuedAt, jkt, publicJwk, ath, nonce };
}

function decodeHeader(proof: string): { alg?: string; typ?: string; jwk?: unknown } {
  try {
    return decodeProtectedHeader(proof);
  } catch (cause) {
    throw new DPoPVerificationError(
      'dpop.malformed',
      'DPoP proof has an unreadable protected header.',
      { cause },
    );
  }
}

function readProofJwk(jwk: unknown): JWK {
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
    throw new DPoPVerificationError(
      'dpop.missing_jwk',
      'DPoP proof header must embed the public key as a jwk.',
    );
  }

  const candidate = jwk as JWK;

  if (candidate.kty === 'oct' || 'd' in candidate || 'k' in candidate) {
    throw new DPoPVerificationError(
      'dpop.private_key_material',
      'DPoP proof header must not contain private key material.',
    );
  }

  return candidate;
}

async function importProofKey(jwk: JWK, algorithm: string): Promise<CryptoKey> {
  try {
    const key = await importJWK(jwk, algorithm);

    if (key instanceof Uint8Array) {
      throw new Error('symmetric key material');
    }

    return key;
  } catch (cause) {
    throw new DPoPVerificationError(
      'dpop.invalid_key',
      'DPoP proof header carries an unusable public key.',
      { cause },
    );
  }
}

async function verifySignature(
  proof: string,
  key: CryptoKey,
  algorithm: string,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(proof, key, { algorithms: [algorithm] });
    return payload;
  } catch (cause) {
    if (cause instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new DPoPVerificationError(
        'dpop.invalid_signature',
        'DPoP proof signature does not verify against its embedded key.',
        { cause },
      );
    }

    throw new DPoPVerificationError('dpop.invalid_claims', 'DPoP proof claims are not acceptable.', {
      cause,
    });
  }
}

/**
 * A proof carrying an `ath` we were not given a token for is rejected rather than
 * ignored: silently skipping the check would drop the token binding.
 */
async function verifyAth(ath: string | undefined, accessToken: string | undefined): Promise<void> {
  if (ath === undefined && accessToken === undefined) {
    return;
  }

  if (ath === undefined || accessToken === undefined) {
    throw new DPoPVerificationError(
      'dpop.ath_mismatch',
      'DPoP proof and request disagree on whether an access token is bound.',
    );
  }

  if (!timingSafeEqual(ath, await calculateAth(accessToken))) {
    throw new DPoPVerificationError(
      'dpop.ath_mismatch',
      'DPoP proof is not bound to the presented access token.',
    );
  }
}

async function calculateAth(accessToken: string): Promise<string> {
  return base64url.encode(await sha256(accessToken));
}

function readStringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === 'string' ? value : undefined;
}

/** RFC 9449 §4.2: `htu` is the request URI without query and fragment. */
function normalizeHtu(url: string | URL): string | null {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function toHtu(url: string | URL): string {
  const normalized = normalizeHtu(url);

  if (normalized === null) {
    throw new MitaError('config.invalid_url', `"${String(url)}" is not an absolute URL.`);
  }

  return normalized;
}
