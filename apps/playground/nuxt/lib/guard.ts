import { createSecurityGuard } from '@mita-auth/server';
import { createPlaygroundRedis } from '@mita-playground/fake-upstash';

import { RATE_LIMIT, TURNSTILE_SECRET_KEY } from './config';

const { redis, backend } = createPlaygroundRedis();

export const redisBackend = backend;

export const guard = createSecurityGuard({
  redis,
  // Localhost carries none of the proxy headers the default identifier reads, so every
  // visitor would share the unidentified bucket regardless. Saying so outright makes the
  // rate limit scenario deterministic rather than incidental.
  rateLimit: { ...RATE_LIMIT, identifier: () => 'playground' },
  turnstile: { secretKey: TURNSTILE_SECRET_KEY },
  dpop: true,
});
