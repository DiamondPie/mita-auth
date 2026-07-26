import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // happy-dom never fetches an external script. Left to itself it logs a DOMException
    // for every one, including the ones the Turnstile tests inject on purpose; treating
    // the refusal as a quiet load keeps a deliberate case from reading like an accident.
    environmentOptions: {
      happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: true } },
    },
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Re-exports only. v8 attributes no statements to either, so they report a flat 0%
      // that reads as a gap while there is nothing in them that could be covered.
      exclude: ['src/index.ts', 'src/ky.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
