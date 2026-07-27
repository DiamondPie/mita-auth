/**
 * Shapes the wire protocol relies on, kept apart from the schemas built out of them.
 *
 * `schemas.ts` pulls in Zod, and `@mita-auth/core` is bundled one file per entry point:
 * a module that reaches in here for a regex would drag Zod along with it, into browser
 * bundles that never validate anything. These constants have no dependencies at all, so
 * both the signing path and the schemas can share them without that cost.
 */

export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Compact JWS serialization: three base64url segments. */
export const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Longest DPoP proof accepted before anything is parsed.
 *
 * A proof carries a public JWK, so it is larger than a typical JWT but nowhere near this;
 * the cap is here to bound the work a rejected request can ask for.
 */
export const MAX_DPOP_PROOF_LENGTH = 4096;

/** SHA-256 JWK thumbprint (RFC 7638), always 43 base64url characters. */
export const JWK_THUMBPRINT_LENGTH = 43;

/** Cloudflare caps Turnstile tokens at 2048 characters. */
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
