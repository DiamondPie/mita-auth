# @mita-auth/server

Server half of [Mita](https://github.com/DiamondPie/mita-auth): rate limiting, Cloudflare
Turnstile verification, DPoP replay protection, and HTML escaping — behind one `verify()`
call that takes a `Request` and hands back either a pass or the `Response` to return.

> 🚧 0.x — the public API may still change between minor releases. Pin a minor range if that
> matters to you.

## Install

```bash
pnpm add @mita-auth/server
```

A production deployment needs an [Upstash Redis](https://upstash.com) database — the nonce
and spent-proof stores have to be durable and shared. For local development there is
`@mita-auth/server/memory`, which needs no Upstash account. It is a different set of stores,
not a different dependency tree: `@upstash/ratelimit` is a hard dependency of this package
and is present either way.

## Usage

```ts
import { createSecurityGuard } from '@mita-auth/server';

const guard = createSecurityGuard({
  redis: { url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! },
  rateLimit: { requests: 10, window: '1 m' },
  turnstile: { secretKey: process.env.TURNSTILE_SECRET_KEY! },
  dpop: true,
});

export async function POST(request: Request): Promise<Response> {
  const check = await guard.verify(request);

  // The limiter owes background work on both outcomes, so hand it over before returning.
  after(check.pending); // Next.js; `ctx.waitUntil(check.pending)` on Workers

  if (!check.success) {
    return check.response;
  }

  // `check.headers` carries the next DPoP-Nonce. Dropping it leaves the client unable to
  // sign anything afterwards — attach it to every response, errors included.
  return Response.json({ ok: true }, { status: 201, headers: check.headers });
}
```

## Running without Redis

```ts
import { createSecurityGuard } from '@mita-auth/server';
import { createMemoryRateLimiter, createMemoryReplayStore } from '@mita-auth/server/memory';

const guard = createSecurityGuard({
  rateLimiter: createMemoryRateLimiter({ requests: 10, window: '1 m' }),
  replayStore: createMemoryReplayStore(),
  dpop: true,
});
```

Everything else behaves the same — same sliding window, same single-use nonces, same
`verify()`.

Only DPoP touches the replay store, and it is built on demand: a guard that omits `dpop`
never asks for one, so rate limiting plus Turnstile needs neither `replayStore` nor `redis`.

**Never ship this.** Both stores live in one instance's memory: a second instance shares
nothing with the first, so the rate limit divides by however many are running, and a spent
nonce becomes redeemable again as soon as the instance that spent it goes away — which on
Edge is most requests. That is why it is a separate entry point: one import line to find in
review, one string to grep for before a deploy.

## What it contains

| Area | Exports |
| --- | --- |
| Guard | `createSecurityGuard` |
| Rate limiting | `createRateLimiter`, `resolveClientIp` |
| Replay protection | `createReplayStore` |
| Turnstile | `verifyTurnstileToken` |
| Escaping | `escapeHtml` |
| Development stores (`/memory`) | `createMemoryRateLimiter`, `createMemoryReplayStore` |

## Notes

- **`check.pending` is not optional on Edge.** The rate limiter owes a background write; if
  the runtime is not told to wait for it, the response returns and the write is cut off,
  losing rate-limit and analytics data silently.
- **`check.headers` belongs on *every* response, your own 4xx included.** It carries the next
  `DPoP-Nonce`, and dropping it fails silently rather than loudly: the client simply has no
  nonce to sign the next request with, so every call degrades into a handshake plus the real
  request — two round trips and two rate-limit tokens instead of one, with nothing in the
  logs to say why. Returning a validation error without the headers is the easiest way to
  cause it.
- **Name the header your platform actually controls.** The default rate-limit identifier is
  the client IP, and without `clientIpHeader` it is a guess: `resolveClientIp` tries
  `cf-connecting-ip`, `x-real-ip` and `x-forwarded-for` in that order, and a fixed order
  cannot know which one *your* proxy is the one overwriting. Anywhere but Cloudflare it lets
  a header the visitor set win over the one the platform set, and a visitor sending a new
  one per request gets a fresh bucket every time — a rate limit in name only.

  | Deployment | `clientIpHeader` |
  | --- | --- |
  | Cloudflare Workers / proxy | `'cf-connecting-ip'` |
  | Vercel | `'x-real-ip'` |
  | nginx / Traefik / ALB | whichever header you overwrite — and check that it *overwrites* rather than appends |
  | Bare Node, no proxy | none of them work; pass `rateLimit.identifier` derived from something you can verify |

  Named, it is the only header consulted and its value is taken whole — a comma in a header
  you control is data, not a chain. If it is absent, empty, or longer than
  `MAX_CLIENT_IP_LENGTH`, which a forwarding chain of two IPv6 addresses already is, the
  request falls to the shared bucket rather than back to the guess. It applies to
  `turnstile.remoteIp` as well, which asks the same question of the same request.

  It reaches only the limiter the guard builds itself. Hand it a `rateLimiter` — as the
  section above does — and that limiter keeps its own resolver, so pass the header there
  too: `createRateLimiter` and `createMemoryRateLimiter` both take `clientIpHeader`. Left
  off, the limiter goes on guessing while `turnstile.remoteIp` does not.
- **With no usable header present at all, every request shares one bucket.** Requests the
  identifier cannot place fall back to a single shared key, deliberately — failing open per
  visitor would be worse. But on an un-proxied deployment *no* request carries an IP header,
  so the whole site shares one `requests: 10, window: '1 m'` budget and the sixth visitor of
  the minute gets a 429. The fixes are the ones in the table above.
- **Failure modes differ by concern, on purpose.** Rate limiting fails open (an Upstash
  outage should not take the endpoint down), Turnstile fails closed (failing open would let
  anyone who can blackhole siteverify skip the human check), and replay protection is always
  closed and has no switch. `turnstile.failureMode: 'open'` is a choice about outages and
  covers only those: a secret key Cloudflare refuses answers 503 regardless, because it will
  not heal on its own and failing open on it turns the human check off silently and
  indefinitely.
- **Turnstile is checked last, and that costs the client a nonce when it fails.** The order
  is rate limit → token present → DPoP → siteverify, so that a request destined to be retried
  never burns Cloudflare's single-use token. The trade is that anything failing *after* DPoP
  — a `turnstile_rejected` 403, a `turnstile_unavailable` 503 — has already spent the
  client's nonce and returns no replacement, so the visitor's next call pays for a handshake:
  one extra round trip and one extra rate-limit token. `nonceRetryLimit: 1` on the client
  absorbs it, but size the limits with it in mind.
- **`escapeHtml` turns markup into text; it does not filter.** Escape either on write or on
  render, never both — its output belongs in `v-html` / `dangerouslySetInnerHTML`, not in
  ordinary text interpolation, which would escape it a second time.
- **`escapeHtml` covers two contexts, not every context.** It is safe for an HTML text node
  and for a quoted attribute value. Unquoted attribute values, `<script>` and `<style>`
  bodies, `href` / `src` URLs and inline CSS each need their own encoding, and this function
  does not provide it — dropping its output into one of those is still an injection.
- **A 503 says `turnstile_unavailable` and nothing else.** Pass `turnstile.onUnavailable` to
  learn which one it was: a Cloudflare outage, a runtime without `AbortSignal.timeout`, and a
  response that was not JSON all look identical from the outside, and with the default
  fail-closed policy any of them takes every write down. A secret key that is missing or
  wrong arrives here too, and is the likeliest of the lot — Cloudflare never judged the
  visitor, so calling it a rejection would have blamed them for a deployment's own typo. It
  arrives carrying `misconfigured: true`, which is the one case `failureMode: 'open'` does
  not cover.
- **`turnstile.remoteIp` is off by default.** Cloudflare sharpens its verdict with the
  visitor's IP, but the headers it comes from are client-supplied unless a trusted proxy
  overwrites them, and a wrong IP makes the scoring worse rather than better. Turn it on
  once `clientIpHeader` names the header your platform sets — the table above is the same
  answer for both. On a bare Node server with no proxy, leave it off.
- Web-standard APIs only, compiled against the WebWorker lib with `types: []`. Runs on Node,
  Vercel Edge and Cloudflare Workers.

## License

MIT
