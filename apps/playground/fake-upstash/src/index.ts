import { Redis, type Requester } from '@upstash/redis';

import { createInMemoryRedis, type RedisCommand } from './redis';

export { createInMemoryRedis, type InMemoryRedis, type RedisCommand } from './redis';

/** Which store the guard ended up talking to. Worth surfacing: it qualifies every result. */
export type PlaygroundRedisBackend = 'upstash' | 'in-memory';

export interface PlaygroundRedis {
  redis: Redis;
  backend: PlaygroundRedisBackend;
}

/**
 * A `Requester` the Upstash client will drive instead of HTTP.
 *
 * Handing `Redis` a requester rather than a URL keeps the whole store in-process: no port,
 * no second terminal, and no chance of the demos racing each other over one fake server.
 * It also switches auto-pipelining off, so every command arrives here on its own.
 */
export function createFakeUpstash(): Requester {
  const store = createInMemoryRedis();

  return {
    readYourWrites: false,
    async request<TResult>(request: { body?: unknown }): Promise<{ result: TResult }> {
      return { result: store.execute(request.body as RedisCommand) as TResult };
    },
  };
}

/**
 * Resolves the Redis the playground's guards run against.
 *
 * With `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set this is the real thing,
 * sliding window and TTLs included; without them it is {@link createFakeUpstash}, which is
 * what makes the demos runnable offline. The `backend` is reported back so a run can say
 * which of the two produced it.
 */
export function createPlaygroundRedis(): PlaygroundRedis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url !== undefined && url !== '' && token !== undefined && token !== '') {
    return { redis: new Redis({ url, token }), backend: 'upstash' };
  }

  return { redis: new Redis(createFakeUpstash()), backend: 'in-memory' };
}
