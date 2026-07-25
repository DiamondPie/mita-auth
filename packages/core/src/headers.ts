/**
 * Wire-protocol header names shared by `@mita/client` and `@mita/server`.
 *
 * `dpop` and `dpopNonce` follow RFC 9449 verbatim; the Turnstile header is Mita-specific.
 * Header names are lowercase because the Fetch `Headers` API lowercases on lookup anyway.
 */
export const MITA_HEADERS = {
  /** Request: the compact DPoP proof JWT. */
  dpop: 'dpop',
  /** Response: the freshness challenge the next proof must echo in its `nonce` claim. */
  dpopNonce: 'dpop-nonce',
  /** Request: the Cloudflare Turnstile token awaiting server-side siteverify. */
  turnstile: 'x-mita-turnstile',
} as const;

export type MitaHeaderName = (typeof MITA_HEADERS)[keyof typeof MITA_HEADERS];

/** `WWW-Authenticate` scheme to emit when a DPoP-protected request is rejected. */
export const DPOP_AUTH_SCHEME = 'DPoP';
