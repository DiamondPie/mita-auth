# @mita-auth/react

React bindings for [Mita](https://github.com/DiamondPie/mita-auth): four hooks over
`@mita-auth/client`'s nanostores state, and a `<MitaTurnstile>` component wrapping the
`<mita-turnstile>` custom element.

> 🚧 0.x — the public API may still change between minor releases. Pin a minor range if that
> matters to you.

## Install

```bash
pnpm add @mita-auth/react @mita-auth/client
```

Peer: `react@^18 || ^19`.

## Usage

```tsx
'use client';

import { MitaTurnstile, useHasProvenKey, useTurnstileStatus } from '@mita-auth/react';

export function CommentForm({ siteKey }: { siteKey: string }) {
  const provenKey = useHasProvenKey();
  const turnstile = useTurnstileStatus();

  return (
    <form>
      {/* … */}
      <MitaTurnstile siteKey={siteKey} onError={(code) => console.warn(code)} />
      <button disabled={turnstile !== 'solved'}>Post</button>
      {provenKey ? <span>session active</span> : null}
    </form>
  );
}
```

## Exports

| Hook | Reads |
| --- | --- |
| `useHasProvenKey()` | whether the server has accepted a proof from this browser's key pair — **not a sign-in check**, see Notes |
| `useSessionStatus()` | `'idle' \| 'active' \| 'unauthorized'` |
| `useTurnstileStatus()` | `'idle' \| 'pending' \| 'solved' \| 'spent' \| 'expired' \| 'error'` |
| `useTurnstileToken()` | the unspent token, or `null` |

Plus `MitaTurnstile` and its props type.

## Notes

- **`useHasProvenKey()` is not an identity check.** Mita has no login step: the DPoP exchange
  proves that a request was signed by whoever holds a given private key and that the same key
  signed the ones before it, never who that is. Every visitor gets a key pair on their first
  request, so `useHasProvenKey()` turns `true` for all of them. Use it to show connection
  state; never to gate anything only some people should reach.
- This package is a binding layer only. It deliberately does not re-export
  `@mita-auth/client`'s surface, so `createProtectedClient` is imported from there.
- Every export is a hook or a client component, so the built entry carries `'use client'`.
  Importing it from a React Server Component is fine; calling into it is not.
- One hook per store rather than one aggregate hook: the stores are atomic, and aggregating
  would re-render every subscriber whenever any one of them changed.

## License

MIT
