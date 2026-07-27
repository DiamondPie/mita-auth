# Mita

**A batteries-included, framework-agnostic authentication & anti-abuse protection SDK.**
Write the core logic once, and it works across Next.js / Nuxt / React / Vue / vanilla JS — built to be reused across your personal site and every project after it.

> Status: 🚧 In development — all five packages (`@mita-auth/core`, `@mita-auth/server`, `@mita-auth/client`, `@mita-auth/react`, `@mita-auth/vue`) are complete, and the [Next.js + Nuxt playground](./apps/playground) confirms the zero-framework-adaptation claim: the two demos share six byte-identical business modules, and their SDK-touching code differs in four places, all framework idiom. `@mita-auth/server` has since been measured on Cloudflare Workers and Vercel Edge — the same guard chain, line for line, with no source change and no `nodejs_compat` flag. Publishing is next. Nothing is on npm yet.

*[中文版 / Chinese version](./README_zh.md)*

---

## What is this

The security logic behind a typical comment section or guestbook — human verification, rate limiting, XSS sanitization, anti-replay signing — is fundamentally UI-framework-agnostic, yet it usually gets rewritten from scratch in every new project. Mita pulls that logic out into a standalone, auditable open-source SDK: the core is a thin glue layer over mature, community-vetted dependencies, not a reinvention of cryptography or rate-limiting algorithms.

## Design Goals

1. **Framework-agnostic**: core logic has zero UI framework dependency — React, Vue, Svelte, and plain HTML can all consume it directly.
2. **Don't reinvent the wheel**: the project is a glue layer with sane, opinionated defaults; cryptography, networking, and rate limiting all lean on mature, community-vetted libraries.
3. **Import only what you need**: split into small packages so frontend projects are never forced to pull in Node.js-only dependencies.
4. **Open source + auditable**: MIT licensed. Security logic stays public and reviewable (security through transparency, not obscurity).
5. **Edge-first**: compatible with Vercel Edge, Cloudflare Workers, and Node.js runtimes by default.

## License

**MIT License** — see [LICENSE](./LICENSE). Core protection logic stays public and transparent — but secrets, Redis connection strings, encryption salts, and any other project-specific sensitive config must always be injected via environment variables and never committed to this repository.

---

Each package documents its own surface, wire format, and runtime requirements in its README: [core](./packages/core), [server](./packages/server), [client](./packages/client), [react](./packages/react), [vue](./packages/vue). The tech-stack and architecture decisions behind them are kept as development notes in the working tree and are not part of the published repository.
