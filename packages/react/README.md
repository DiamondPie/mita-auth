# @mita-auth/react

React bindings for [Mita](https://github.com/DiamondPie/mita-auth): four hooks over
`@mita-auth/client`'s nanostores state, and a `<MitaTurnstile>` component wrapping the
`<mita-turnstile>` custom element.

> 🚧 In development. Nothing is published to npm yet, and the public API may still change.

## Install

```bash
pnpm add @mita-auth/react @mita-auth/client ky
```

Peer: `react@^18 || ^19`.

## Usage

```tsx
'use client';

import { MitaTurnstile, useIsAuthenticated, useTurnstileStatus } from '@mita-auth/react';

export function CommentForm({ siteKey }: { siteKey: string }) {
  const authenticated = useIsAuthenticated();
  const turnstile = useTurnstileStatus();

  return (
    <form>
      {/* … */}
      <MitaTurnstile siteKey={siteKey} onError={(code) => console.warn(code)} />
      <button disabled={turnstile !== 'solved'}>Post</button>
      {authenticated ? <span>session active</span> : null}
    </form>
  );
}
```

## Exports

| Hook | Reads |
| --- | --- |
| `useIsAuthenticated()` | whether the server has accepted a proof from this browser |
| `useSessionStatus()` | `'idle' \| 'active' \| 'unauthorized'` |
| `useTurnstileStatus()` | `'idle' \| 'pending' \| 'solved' \| 'spent' \| 'expired' \| 'error'` |
| `useTurnstileToken()` | the unspent token, or `null` |

Plus `MitaTurnstile` and its props type.

## Notes

- This package is a binding layer only. It deliberately does not re-export
  `@mita-auth/client`'s surface, so `createProtectedClient` is imported from there.
- Every export is a hook or a client component, so the built entry carries `'use client'`.
  Importing it from a React Server Component is fine; calling into it is not.
- One hook per store rather than one aggregate hook: the stores are atomic, and aggregating
  would re-render every subscriber whenever any one of them changed.

## License

MIT
