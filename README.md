# Mita

**A batteries-included, framework-agnostic authentication & anti-abuse protection SDK.**
Write the core logic once, and it works across Next.js / Nuxt / React / Vue / vanilla JS — built to be reused across your personal site and every project after it.

> Status: 🚧 In development — all five packages (`@mita-auth/core`, `@mita-auth/server`, `@mita-auth/client`, `@mita-auth/react`, `@mita-auth/vue`) are complete; a Next.js + Nuxt playground for cross-framework validation is next. Nothing is published to npm yet.

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

Planned: **MIT License**. Core protection logic stays public and transparent — but secrets, Redis connection strings, encryption salts, and any other project-specific sensitive config must always be injected via environment variables and never committed to this repository.

---

For the confirmed tech stack, monorepo architecture, build/release pipeline, and roadmap, see [temp/plan.md](./temp/plan.md).
