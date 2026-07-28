# @mita-auth/client

Browser half of [Mita](https://github.com/DiamondPie/mita-auth): a `ky` instance that signs
every request with a DPoP proof, reactive state built on nanostores, and the
`<mita-turnstile>` custom element.

> 🚧 0.x — the public API may still change between minor releases. Pin a minor range if that
> matters to you.

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

It dispatches `mita-verified`, `mita-expired` and `mita-error` — the names are also on
`MITA_TURNSTILE_EVENTS`. They are prefixed because the events bubble and are composed: a
plain `error` would reach `window`, where front-end monitoring listens, and a visitor who
simply failed a challenge would be filed as a page error.

## State

`$sessionStatus`, `$hasProvenKey`, `$turnstileStatus` and `$turnstileToken` are nanostores
atoms. Subscribe with `.subscribe()`, or use the framework bindings.

A session turns `active` the moment the server accepts a proof signed by this browser's key
pair — there is no login step. `$hasProvenKey` reports exactly that and nothing more: the
DPoP exchange proves that a request was signed by whoever holds a given private key and that
the same key signed the ones before it, never who that is. Every visitor gets a key pair on
their first request, so it turns `true` for all of them — **it cannot gate anything only some
people should reach**.

## Notes

- **Reading a failure needs no second package.** `createProtectedClient` returns a ky
  instance and ky reports a refusal by throwing, so `isHTTPError`, `isNetworkError`,
  `isTimeoutError` and `KyInstance` are re-exported from here. Anything past that is ky's
  own API — import `ky` directly for it. `MitaError` and `isMitaError` come across for the
  same reason: a refusal Mita made on its own has no response to inspect, only a `code`.
- **Add to the instance's hooks; never replace them.** The protocol lives in them — signing
  and queueing in `init`, the Turnstile header in `beforeRequest`, the nonce handshake in
  `afterResponse`. ky *appends* hooks that a call or an `extend()` supplies, so adding is
  safe. `hooks: replaceOption({ … })` and `hooks: { init: undefined }` are the two that drop
  them instead, and what is left is plain ky: requests go out unsigned, unqueued and without
  a token, with nothing to show for it locally beyond the server refusing them.
- **The first request to a server is answered with a 401.** RFC 9449 defines that rejection
  as the nonce handshake; the client resolves it and retries on its own, which costs one
  extra round trip and one extra rate-limit token per cold start. Size your rate limits with
  that in mind. In full, one cold-start submission is 2 requests, 2 rate-limit tokens and 1
  human verification — and any failure invalidates the token, so an interactive site key
  makes the visitor solve another challenge before they can retry.
- **Requests on one instance are sent one at a time, and share one `timeout` budget.** A
  nonce is redeemed exactly once, so attempts queue behind each other. A burst costs no more
  requests than it would serially, but it does not run in parallel — and ky starts its
  per-attempt timer before an attempt reaches the queue, so waiting in line is charged
  against the same `timeout` as the round trip. With ky's 10 s default, the `⌊10000 / RTT⌋`th
  concurrent call is where that budget runs out. Raise `timeout` in proportion to how deep
  your bursts get — per call or for the whole instance, both are honoured — or give
  independent bursts their own client. An attempt that reaches the front of the queue having
  spent more of its budget waiting than a round trip has left to cost is rejected with a
  `MitaError` whose code is `client.queue_saturated`, rather than being sent and reported as
  a timeout it never had a chance to beat. The wait is measured rather than predicted from
  how many calls are in flight, so a burst that turns out to be fast is not refused on the
  strength of one slow sample; the budget weighed is `min(timeout, totalTimeout)`, since ky
  charges an attempt against both. A request with nothing ahead of it is never refused this
  way — it has the whole budget, and ky's own timer is the judge of that.
- **One Turnstile token per submission.** Sending it spends it; the widget watches for that
  and asks the visitor's browser for a fresh challenge without being told. This happens when
  the request goes out, not when it succeeds, so a rejection the server made *before*
  reaching Cloudflare — a 429, a 401, a missing-token 403 — still costs the visitor a fresh
  challenge even though the token was never redeemed upstream.
- **At most one `<mita-turnstile>` per page.** The widget's state is a single module-level
  store, so a second element on the same page writes over the first one's token, resets when
  the first one submits, and reports a status the UI cannot attribute to either. One form per
  page with a challenge on it, or one shared widget above both.
- Key pairs are generated non-extractable and held only in memory. Closing the tab ends the
  session.
- Importing the main entry on a server is harmless: the element module falls back to an
  empty base class where `HTMLElement` is absent.
- **Build the client from browser code.** The stores are module-level, which in a tab means
  one per page and in a server process means one shared by every request it handles.
  Creating the client — or letting a request run — during SSR leaks one visitor's session
  state into the next. Construct it lazily from an event handler, not at module scope.

## License

MIT
