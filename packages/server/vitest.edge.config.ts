import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The same suite against globals that only an Edge runtime exposes. Coverage stays with
    // the node run; the one question here is whether the suite still holds once the global
    // object is swapped out.
    environment: 'edge-runtime',
    include: ['src/**/*.test.ts'],
    coverage: { enabled: false },
  },
});
