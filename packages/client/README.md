# @mita-auth/client

Browser half of [Mita](https://github.com/DiamondPie/mita-auth): a `ky` instance that signs
every request with a DPoP proof, reactive state built on nanostores, and the
`<mita-turnstile>` custom element.

> 🚧 In development. Nothing is published to npm yet, and the public API may still change.

Framework-agnostic on purpose — React and Vue bindings live in
[`@mita-auth/react`](https://github.com/DiamondPie/mita-auth/tree/main/packages/react) and
[`@mita-auth/vue`](https://github.com/DiamondPie/mita-auth/tree/main/packages/vue).

## Install

```bash
pnpm add @mita-auth/client
```

## Usage

```ts
import { createProtectedClient, isHTTPError } from '@mita-auth/client';

const api = createProtectedClient({
  onUnauthorized: ({ reason }) => console.warn('not authorized:', reason),
});

try {
  await api.post('https://api.example.com/comments', { json: { content: 'hi' } }).json();
} catch (cause) {
  if (isHTTPError(cause)) {
    console.error(cause.response.status, cause.data);
  }
}
```

Registering the widget is a side effect, so it lives in its own entry point — importing it
is what puts `<mita-turnstile>` in the custom element registry:

```ts
import '@mita-auth/client/turnstile';
```

```html
<mita-turnstile site-key="0x4AAA..."></mita-turnstile>
```

## State

`$sessionStatus`, `$isAuthenticated`, `$turnstileStatus` and `$turnstileToken` are nanostores
atoms. Subscribe with `.subscribe()`, or use the framework bindings.

A session turns `active` the moment the server accepts a proof signed by this browser's key
pair — there is no login step.

## Notes

- **Reading a failure needs no second package.** `createProtectedClient` returns a ky
  instance and ky reports a refusal by throwing, so `isHTTPError`, `isNetworkError`,
  `isTimeoutError` and `KyInstance` are re-exported from here. Anything past that is ky's
  own API — import `ky` directly for it.
- **The first request to a server is answered with a 401.** RFC 9449 defines that rejection
  as the nonce handshake; the client resolves it and retries on its own, which costs one
  extra round trip and one extra rate-limit token per cold start. Size your rate limits with
  that in mind.
- **Requests on one instance are sent one at a time.** A nonce is redeemed exactly once, so
  attempts queue behind each other. A burst costs no more requests than it would serially,
  but it does not run in parallel either.
- **One Turnstile token per submission.** Sending it spends it; the widget watches for that
  and asks the visitor's browser for a fresh challenge without being told.
- Key pairs are generated non-extractable and held only in memory. Closing the tab ends the
  session.
- Importing the main entry on a server is harmless: the element module falls back to an
  empty base class where `HTMLElement` is absent.

## License

MIT
