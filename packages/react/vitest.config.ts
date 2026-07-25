import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // index.ts is re-exports only.
      exclude: ['src/index.ts'],
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
