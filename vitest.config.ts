import { defineConfig } from 'vitest/config';

// Only used when running `vitest` from the repo root (aggregated watch mode).
// `turbo run test` invokes `vitest run` inside each package instead, where
// each package's own vitest.config.ts takes precedence over this one.
export default defineConfig({
  test: {
    projects: ['packages/*'],
    passWithNoTests: true,
  },
});
