---
"@mita-auth/core": minor
"@mita-auth/server": minor
"@mita-auth/client": minor
"@mita-auth/react": minor
"@mita-auth/vue": minor
---

First release. DPoP proof-of-possession over a Web-standard request guard: rate
limiting, Cloudflare Turnstile verification, nonce and jti replay protection, HTML
escaping — backed by Upstash Redis or by in-process stores for development — plus a
browser client that speaks the protocol on its own and thin React and Vue bindings
over its shared state.
