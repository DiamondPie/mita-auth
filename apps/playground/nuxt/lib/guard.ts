import { createSecurityGuard } from '@mita-auth/server';
import { createMemoryRateLimiter, createMemoryReplayStore } from '@mita-auth/server/memory';

import { RATE_LIMIT, TURNSTILE_SECRET_KEY } from './config';

const rateLimit = {
  ...RATE_LIMIT,
  // Localhost carries none of the proxy headers the default identifier reads, so every
  // visitor would share the unidentified bucket regardless. Saying so outright makes the
  // rate limit scenario deterministic rather than incidental.
  identifier: () => 'playground',
};

/**
 * The demo's guard, running entirely inside this process.
 *
 * The two stores come from `@mita-auth/server/memory` — the published package, not a fixture
 * private to this repository. That is the point: a project that runs `pnpm add` gets exactly
 * this, and the playground starts with no account anywhere.
 *
 * A real deployment swaps the two store options for the credentials:
 *
 * ```ts
 * redis: {
 *   url: process.env.UPSTASH_REDIS_REST_URL!,
 *   token: process.env.UPSTASH_REDIS_REST_TOKEN!,
 * },
 * rateLimit,
 * ```
 */
export const guard = createSecurityGuard({
  rateLimiter: createMemoryRateLimiter(rateLimit),
  replayStore: createMemoryReplayStore(),
  turnstile: { secretKey: TURNSTILE_SECRET_KEY },
  dpop: true,
});

/**
 * Reported to the page, because it qualifies every result the demo produces: nothing here
 * outlives a restart, and a second instance would count its own requests.
 */
export const storeBackend = 'in-memory';
