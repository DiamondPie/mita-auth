# playground

Two comment-box demos — one Next.js, one Nuxt — built on the same five `@mita-auth` packages.

They exist to test one claim from [temp/plan.md](../../temp/plan.md): that Mita needs **no
framework adaptation code**. The way to read this directory is to diff the two demos and
check that what is left is framework idiom rather than SDK plumbing. The
[comparison](#the-comparison) below is that diff, measured.

```text
apps/playground/
├── next/   # Next.js App Router · @mita-auth/react
└── nuxt/   # Nuxt · @mita-auth/vue
```

## Running them

Both demos import the library packages from their `dist`, so those have to be built first.

```bash
pnpm install
pnpm turbo run build --filter="./packages/*"
```

Then start whichever demo you want — they listen on different ports, so both at once is fine:

```bash
pnpm --filter @mita-playground/next dev    # http://localhost:3000
pnpm --filter @mita-playground/nuxt dev    # http://localhost:3001
```

To exercise the production build instead of the dev server:

```bash
pnpm turbo run build --filter="@mita-playground/*"
pnpm --filter @mita-playground/next start                    # http://localhost:3000
PORT=3001 pnpm --filter @mita-playground/nuxt preview        # http://localhost:3001
```

`nuxt preview` reads `PORT` rather than taking the port from the `dev` script, so it needs to
be told when the Next demo already holds 3000.

Both are worth running. The dev server and the production bundle are not the same program,
and Phase 4 found a defect that only existed in one of them (see [what this caught](#what-this-caught)).

## The store, and why the badge matters

`createSecurityGuard` needs somewhere to keep rate-limit counters and spent nonces. Both
demos use `@mita-auth/server/memory`, which holds both in the server process — no extra
service, no extra port, works offline.

That is the published package, not a fixture private to this repository. It is what a
project gets from `pnpm add`, which is the point: the demos are only as easy to start as
Mita itself is.

`lib/guard.ts` shows the two lines a real deployment swaps in to point at Upstash instead.

The page carries the badge because it qualifies every result: nothing in an in-memory store
outlives a restart, and a second instance would count its own requests. Everything recorded
under [the four scenarios](#the-four-scenarios) was observed against it; a run against real
Upstash is left for Phase 5, which needs live credentials anyway.

## Turnstile keys

Hard-coded to [Cloudflare's published test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
which work on any domain including localhost. The secret is `1x0000000000000000000000000000000AA`
(accepts every token the test sitekeys mint), and the form offers a choice of two sitekeys:

| Sitekey | Behaviour | What it is for |
|---|---|---|
| `1x00000000000000000000AA` | solves itself on render | the ordinary path, and rapid submissions |
| `3x00000000000000000000FF` | waits for a click | submitting while no token exists yet |

The selector is there because the scenarios pull in opposite directions: one needs a widget
that re-solves instantly, another needs one that has not solved at all. Note that
`siteverify` calls do go to Cloudflare for real — these keys shortcut the challenge, not the
verification.

## The four scenarios

Run each against both demos. `RATE_LIMIT` is 5 requests per minute over a single shared
bucket (see [`lib/config.ts`](./next/lib/config.ts)), and the cold-start handshake spends one
of them, so the limit arrives on the fourth submission of a fresh page.

| # | Steps | Expected |
|---|---|---|
| 1 | Leave the sitekey on `1x…AA`, write a comment, submit | `201`. The badges turn `session active` / `turnstile solved` — the widget spent its token and re-solved on its own |
| 2 | Keep submitting | The fourth is refused: *“Too many comments too quickly…”* (`429 rate_limited`) |
| 3 | Switch the sitekey to `3x…FF`, submit without touching the widget | *“Solve the Turnstile challenge before submitting.”* (`403 turnstile_missing`) |
| 4 | Submit `<script>alert(1)</script>` or `<img src=x onerror=alert(1)>` | It appears as the text you typed. Nothing executes: the stored string is `&lt;script&gt;…`, and the rendered node has zero child elements |

Scenario 4 renders comment bodies through `dangerouslySetInnerHTML` / `v-html` on purpose.
`escapeHtml` turns markup into text rather than filtering it, so rendering the stored value
as HTML is what demonstrates the payload survived as characters — rendering it as text would
instead display `&lt;script&gt;` and look like a double-escaping bug.

There is no Playwright suite. Phase 4's goal was to compare code, not to build test
infrastructure; the regression guard that came out of it is a unit test in
`@mita-auth/client` instead.

## The comparison

**The shared modules are byte-identical.** All six of them, no diff at all:

| Module | What it holds |
|---|---|
| `lib/guard.ts` | `createSecurityGuard({ redis, rateLimit, turnstile, dpop: true })` |
| `lib/api.ts` | `createProtectedClient({ onUnauthorized })`, built lazily so the key pair stays in the browser |
| `lib/comments.ts` | the in-memory store, with `escapeHtml` applied on the way in |
| `lib/config.ts` | Turnstile keys and the rate limit |
| `lib/failure.ts` | guard rejection reason → message |
| `lib/types.ts` | the `Comment` shape |

**The SDK-touching lines are 17 on each side and differ in four places.** Everything else —
`guard.verify`, `check.success`, `check.response`, `check.headers`, `commentSchema.safeParse`,
`getApi().post(...)`, both store subscribers — matches character for character:

| # | Next | Nuxt | Verdict |
|---|---|---|---|
| 1 | `from '@mita-auth/react'` | `from '@mita-auth/vue'` | The binding package. Same three names imported from it |
| 2 | `from '@/lib/api'` | `from '~~/lib/api'` | The framework's own path alias |
| 3 | `<MitaTurnstile siteKey={…} />` | `<MitaTurnstile :site-key="…" />` | JSX prop vs Vue attribute binding |
| 4 | `after(check.pending)` | `event.waitUntil(check.pending)` | The framework's own background-work API, handed the same value |

Two differences the handoff expected to see did **not** materialise:

- **No `.value` anywhere.** `useIsAuthenticated()` returns a value in React and a ref in Vue,
  but a ref unwraps in a template, and this component only reads them there.
- **No callback-prop / emits split.** `<MitaTurnstile>` is driven entirely through the
  nanostores state, so neither side wires up an event handler.

What remains is the framework boilerplate the criterion allows: the handler wrapper
(`export async function POST` vs `defineEventHandler`), Nuxt's one `toWebRequest(event)` line,
Next's `export const dynamic` and its GET living in the same file as its POST, and JSX vs SFC
template syntax.

`nuxt.config.ts` is worth a look for what it does **not** contain: no
`vue.compilerOptions.isCustomElement`. A template writing `<mita-turnstile>` by hand would
need it; `<MitaTurnstile>` is a render function, so the tag never reaches Vue's compiler.

## What this caught

The demos are the first time `@mita-auth/server` ran over real HTTP rather than behind msw,
and the first time `@mita-auth/client` ran in a browser behind a real bundler. Four defects
came out of it, none of which any unit test could have seen:

1. **`@mita-auth/client`'s state writers were deleted by the bundler.** nanostores publishes
   `batch()` with a `@__NO_SIDE_EFFECTS__` annotation, so Rollup dropped every
   `batch()`-wrapped writer as a call whose result went unused — six empty functions, and a
   Turnstile integration that silently failed in every production build while the dev server
   worked. Fixed by holding the status and token in one atom, and guarded by
   `packages/client/src/treeshake.test.ts`.
2. **`@mita-auth/react` shipped without its `'use client'` directive**, because bundling keeps
   only the entry's. A Server Component importing the package failed at build time.
3. **`readBody(event)` hung forever** after `toWebRequest(event)` handed the Node stream to
   the web `Request`. Read the body off the converted request instead.
4. **ky's `HTTPError.response` is already consumed.** `error.data` carries the pre-parsed
   body; reading the response instead reduced every named rejection to a generic message.
