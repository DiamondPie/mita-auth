/**
 * Just enough Redis to satisfy `createSecurityGuard`, held in one process's memory.
 *
 * Only the commands Mita's guard actually issues are implemented, and anything else throws
 * rather than returning a plausible-looking answer — a fake that quietly says yes is worse
 * than no fake at all.
 */

export type RedisCommand = readonly [string, ...unknown[]];

interface Entry {
  value: string | number;
  /** Epoch milliseconds, or null for a key that never expires. */
  expiresAt: number | null;
}

export interface InMemoryRedis {
  execute(command: RedisCommand): unknown;
}

export function createInMemoryRedis(): InMemoryRedis {
  const entries = new Map<string, Entry>();

  /** Expiry is lazy: nothing sweeps the map, so a read is where a dead key disappears. */
  const read = (key: string): Entry | null => {
    const entry = entries.get(key);

    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }

    return entry;
  };

  const get = (key: string): string | number | null => read(key)?.value ?? null;

  const incrBy = (key: string, amount: number): number => {
    const current = read(key);
    const next = Number(current?.value ?? 0) + amount;

    entries.set(key, { value: next, expiresAt: current?.expiresAt ?? null });

    return next;
  };

  const pexpire = (key: string, ttlMs: number): void => {
    const entry = read(key);

    if (entry !== null) {
      entry.expiresAt = Date.now() + ttlMs;
    }
  };

  const set = (key: string, value: string | number, args: readonly unknown[]): 'OK' | null => {
    const flags = args.map((argument) => String(argument).toLowerCase());
    const pxIndex = flags.indexOf('px');

    if (flags.some((flag) => flag !== 'nx' && flag !== 'px' && !/^\d+$/.test(flag))) {
      throw new Error(`fake-upstash: unsupported SET options: ${flags.join(' ')}`);
    }

    if (flags.includes('nx') && read(key) !== null) {
      return null;
    }

    const ttlMs = pxIndex === -1 ? null : Number(args[pxIndex + 1]);

    entries.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });

    return 'OK';
  };

  const getdel = (key: string): string | number | null => {
    const value = get(key);
    entries.delete(key);

    return value;
  };

  /**
   * Hand translation of `@upstash/ratelimit`'s single-region sliding window Lua script,
   * whose contract is `[remaining, effectiveLimit]` with a negative remaining meaning the
   * caller is over the limit.
   *
   * The guard's default limiter is the only script the playground ever evaluates, so the
   * script identity is not checked — swapping `rateLimit.limiter` for another algorithm
   * would silently keep getting sliding-window behaviour here.
   */
  const slidingWindowLimit = (keys: readonly unknown[], args: readonly unknown[]): number[] => {
    const currentKey = String(keys[0]);
    const previousKey = String(keys[1]);
    const limit = Number(args[0]);
    const now = Number(args[1]);
    const window = Number(args[2]);
    const incrementBy = Number(args[3]);

    const currentUsed = Number(get(currentKey) ?? 0);
    const percentageInCurrent = (now % window) / window;
    const previousUsed = Math.floor((1 - percentageInCurrent) * Number(get(previousKey) ?? 0));

    if (incrementBy > 0 && previousUsed + currentUsed >= limit) {
      return [-1, limit];
    }

    const updated = incrBy(currentKey, incrementBy);

    if (updated === incrementBy) {
      pexpire(currentKey, window * 2 + 1000);
    }

    return [limit - (updated + previousUsed), limit];
  };

  return {
    execute([name, ...args]) {
      const key = String(args[0]);

      switch (name.toLowerCase()) {
        case 'get':
          return get(key);

        case 'getdel':
          return getdel(key);

        case 'set':
          return set(key, args[1] as string | number, args.slice(2));

        case 'incrby':
          return incrBy(key, Number(args[1]));

        case 'pexpire':
          pexpire(key, Number(args[1]));
          return 1;

        // `evalsha <sha> <numkeys> <key...> <arg...>`; `eval` differs only in carrying the
        // script text where the hash would be.
        case 'eval':
        case 'evalsha': {
          const keyCount = Number(args[1]);

          return slidingWindowLimit(args.slice(2, 2 + keyCount), args.slice(2 + keyCount));
        }

        default:
          throw new Error(`fake-upstash: unimplemented Redis command "${name}"`);
      }
    },
  };
}
