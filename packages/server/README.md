# @mita-auth/server

Server half of [Mita](https://github.com/DiamondPie/mita-auth): rate limiting, Cloudflare
Turnstile verification, DPoP replay protection, and HTML escaping — behind one `verify()`
call that takes a `Request` and hands back either a pass or the `Response` to return.

> 🚧 In development. Nothing is published to npm yet, and the public API may still change.

## Install

```bash
pnpm add @mita-auth/server
```

Requires an [Upstash Redis](https://upstash.com) database: the nonce and spent-proof stores
need somewhere durable to live, and there is no in-memory fallback yet.

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

## What it contains

| Area | Exports |
| --- | --- |
| Guard | `createSecurityGuard` |
| Rate limiting | `createRateLimiter`, `resolveClientIp` |
| Replay protection | `createReplayStore` |
| Turnstile | `verifyTurnstileToken` |
| Escaping | `escapeHtml` |

## Notes

- **`check.pending` is not optional on Edge.** The rate limiter owes a background write; if
  the runtime is not told to wait for it, the response returns and the write is cut off,
  losing rate-limit and analytics data silently.
- **Failure modes differ by concern, on purpose.** Rate limiting fails open (an Upstash
  outage should not take the endpoint down), Turnstile fails closed (failing open would let
  anyone who can blackhole siteverify skip the human check), and replay protection is always
  closed and has no switch.
- **`escapeHtml` turns markup into text; it does not filter.** Escape either on write or on
  render, never both — its output belongs in `v-html` / `dangerouslySetInnerHTML`, not in
  ordinary text interpolation, which would escape it a second time.
- Web-standard APIs only, compiled against the WebWorker lib with `types: []`. Runs on Node,
  Vercel Edge and Cloudflare Workers.

## License

MIT
