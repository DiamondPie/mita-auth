# @mita-auth/core

Framework-agnostic core of [Mita](https://github.com/DiamondPie/mita-auth): DPoP signing and
verification (RFC 9449), nonce generation, and the Zod schemas both halves of the wire
protocol share.

> 🚧 In development. Nothing is published to npm yet, and the public API may still change.

Most projects do not depend on this package directly — `@mita-auth/client` and
`@mita-auth/server` both re-use it and pull it in themselves. Reach for it when you are
writing your own client or server half.

## Install

```bash
pnpm add @mita-auth/core
```

## What it contains

| Area | Exports |
| --- | --- |
| DPoP | `generateDPoPKeyPair`, `importDPoPKeyPair`, `exportDPoPKeyPair`, `signDPoP`, `verifyDPoP`, `calculateJkt` |
| Nonces | `generateNonce`, `createNonce`, `isNonceExpired`, `timingSafeEqual` |
| Wire format | `MITA_HEADERS`, `DPOP_AUTH_SCHEME`, `COMPACT_JWT_PATTERN`, … |
| Errors | `MitaError`, `DPoPVerificationError`, `isMitaError`, `isDPoPVerificationError` |
| Schemas (`/schemas`) | `commentSchema`, `createCommentSchema`, `securityEnvelopeSchema`, `nonceSchema`, … |

## Usage

```ts
import { generateDPoPKeyPair, signDPoP, verifyDPoP } from '@mita-auth/core';

const keyPair = await generateDPoPKeyPair(); // ES256, non-extractable

const proof = await signDPoP(keyPair, {
  method: 'POST',
  url: 'https://api.example.com/comments',
  nonce, // omitted on the very first request; the server answers with one
});

// On the server:
const { jti, jkt } = await verifyDPoP(proof, {
  method: request.method,
  url: request.url,
  nonce,
});
```

The Zod schemas live behind their own entry point:

```ts
import { commentSchema } from '@mita-auth/core/schemas';
```

## Notes

- **Zod is not in the main entry, deliberately.** An entry point is the one boundary a
  package can promise; how a bundler splits chunks behind it, and whether your bundler then
  shakes the unused half back out, is an implementation detail neither side controls. Keeping
  `/schemas` separate is therefore what puts ~16 kB gzip out of reach of a browser that only
  signs proofs, rather than merely likely to. Ask for it when you want the validation, and it
  costs nothing when you do not.
- **Zero I/O by design.** `verifyDPoP` cannot detect a replay on its own: record the `jti`
  it returns for the proof's acceptance window. `@mita-auth/server` does that with Upstash
  Redis.
- **Web Crypto only.** No Node-only API is used, and the package is compiled against the
  WebWorker lib with `types: []` so that stays true. It runs on Node, browsers, Cloudflare
  Workers, Vercel Edge and Deno alike.
- Keys are generated non-extractable and held in memory, so closing a tab leaves nothing
  behind.

## License

MIT
