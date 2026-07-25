/**
 * Every error Mita throws carries a stable, machine-readable `code` so that callers
 * (notably `@mita/server`) can map failures onto HTTP responses without string matching.
 */
export class MitaError<TCode extends string = string> extends Error {
  readonly code: TCode;

  constructor(code: TCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MitaError';
    this.code = code;
  }
}

export const DPOP_ERROR_CODES = [
  'dpop.malformed',
  'dpop.invalid_type',
  'dpop.unsupported_algorithm',
  'dpop.missing_jwk',
  'dpop.private_key_material',
  'dpop.invalid_key',
  'dpop.invalid_signature',
  'dpop.invalid_claims',
  'dpop.invalid_jti',
  'dpop.htm_mismatch',
  'dpop.htu_mismatch',
  'dpop.invalid_issued_at',
  'dpop.issued_in_future',
  'dpop.expired',
  'dpop.ath_mismatch',
  'dpop.nonce_mismatch',
  'dpop.jkt_mismatch',
] as const;

export type DPoPErrorCode = (typeof DPOP_ERROR_CODES)[number];

/** A DPoP proof was rejected. Maps to HTTP 401 with `WWW-Authenticate: DPoP`. */
export class DPoPVerificationError extends MitaError<DPoPErrorCode> {
  constructor(code: DPoPErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'DPoPVerificationError';
  }
}

export function isMitaError(value: unknown): value is MitaError {
  return value instanceof MitaError;
}

export function isDPoPVerificationError(value: unknown): value is DPoPVerificationError {
  return value instanceof DPoPVerificationError;
}
