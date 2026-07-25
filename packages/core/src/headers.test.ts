import { describe, expect, it } from 'vitest';

import { DPOP_AUTH_SCHEME, MITA_HEADERS } from './headers';

describe('MITA_HEADERS', () => {
  // These names are the wire contract between @mita-auth/client and @mita-auth/server: renaming one
  // silently breaks interoperability with already-deployed peers, so pin them here.
  it('pins the header names', () => {
    expect(MITA_HEADERS).toEqual({
      dpop: 'dpop',
      dpopNonce: 'dpop-nonce',
      turnstile: 'x-mita-turnstile',
    });
  });

  it('keeps every name lowercase for Fetch Headers lookups', () => {
    for (const name of Object.values(MITA_HEADERS)) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('DPOP_AUTH_SCHEME', () => {
  it('matches the RFC 9449 WWW-Authenticate scheme', () => {
    expect(DPOP_AUTH_SCHEME).toBe('DPoP');
  });
});
