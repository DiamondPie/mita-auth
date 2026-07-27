/**
 * @vitest-environment node
 *
 * Runs the real `@mita-auth/server` guard behind msw so both halves of the wire protocol are
 * exercised against each other. Every other test in this package asserts one side against
 * a hand-written stand-in, which cannot catch the two drifting apart.
 */
import { MITA_HEADERS } from '@mita-auth/core';
import { createSecurityGuard, TURNSTILE_SITEVERIFY_ENDPOINT } from '@mita-auth/server';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProtectedClient } from './client';
import { isHTTPError } from './ky';
import { $hasProvenKey, resetMitaState, setTurnstileToken } from './state';

const API_URL = 'https://api.test/comments';
const REDIS_URL = 'https://contract.upstash.test';

const server = setupServer();

/** Stands in for Upstash. Only the commands the replay store issues are implemented. */
let redis: Map<string, string>;
let attempts: Array<{ dpop: string | null; turnstile: string | null }>;
let siteverifyCalls: number;
let spentTokens: Set<string>;
let rateLimitRemaining: number;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  redis = new Map();
  attempts = [];
  siteverifyCalls = 0;
  spentTokens = new Set();
  rateLimitRemaining = 9;
  resetMitaState();
  server.use(redisHandler(), siteverifyHandler(true), apiHandler());
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function redisHandler() {
  return http.post(`${REDIS_URL}/pipeline`, async ({ request }) => {
    const commands = JSON.parse(await request.text()) as Array<[string, ...unknown[]]>;

    return HttpResponse.json(commands.map((command) => ({ result: runRedisCommand(command) })));
  });
}

function runRedisCommand([name, ...args]: [string, ...unknown[]]): unknown {
  const key = String(args[0]);

  switch (name) {
    // The sliding-window script; its verdict is `[remaining, reset]`.
    case 'evalsha':
      return [rateLimitRemaining, Date.now() + 60_000];

    case 'getdel': {
      const stored = redis.get(key) ?? null;
      redis.delete(key);
      return stored;
    }

    case 'set': {
      const claimsExclusively = args.some(
        (argument) => typeof argument === 'string' && argument.toLowerCase() === 'nx',
      );

      if (claimsExclusively && redis.has(key)) {
        return null;
      }

      redis.set(key, String(args[1]));
      return 'OK';
    }

    default:
      throw new Error(`Unexpected Redis command in contract test: ${name}`);
  }
}

/**
 * Stands in for Cloudflare, including the part that matters most here: a token is
 * accepted exactly once. A fake that kept saying yes would let the guard verify a token
 * before redeeming the nonce without anything going visibly wrong.
 */
function siteverifyHandler(accepts: boolean) {
  return http.post(TURNSTILE_SITEVERIFY_ENDPOINT, async ({ request }) => {
    siteverifyCalls += 1;

    const token = new URLSearchParams(await request.text()).get('response') ?? '';

    if (!accepts || spentTokens.has(token)) {
      return HttpResponse.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    }

    spentTokens.add(token);

    return HttpResponse.json({
      success: true,
      hostname: 'example.com',
      challenge_ts: new Date().toISOString(),
    });
  });
}

function apiHandler({ turnstileRequired = true } = {}) {
  const guard = createSecurityGuard({
    redis: { url: REDIS_URL, token: 'contract-token' },
    rateLimit: { identifier: () => 'contract' },
    turnstile: { secretKey: 'secret', required: turnstileRequired },
    dpop: true,
  });

  return http.post(API_URL, async ({ request }) => {
    attempts.push({
      dpop: request.headers.get(MITA_HEADERS.dpop),
      turnstile: request.headers.get(MITA_HEADERS.turnstile),
    });

    const check = await guard.verify(request);

    return check.success
      ? HttpResponse.json({ ok: true }, { headers: check.headers })
      : check.response;
  });
}

function client(options: Parameters<typeof createProtectedClient>[0] = {}) {
  return createProtectedClient({ retry: { delay: () => 0 }, ...options });
}

describe('client and server contract', () => {
  it('completes the cold start in exactly one extra round trip', async () => {
    setTurnstileToken('token-1');

    const response = await client().post(API_URL);

    expect(response.status).toBe(200);
    expect(attempts).toHaveLength(2);
    expect($hasProvenKey.get()).toBe(true);
  });

  // The whole reason the guard defers siteverify: Cloudflare accepts a token once, and
  // the client has no second one to offer until the visitor solves another challenge.
  it('spends a single Turnstile token across the handshake', async () => {
    setTurnstileToken('token-1');

    await client().post(API_URL);

    expect(attempts.map((attempt) => attempt.turnstile)).toEqual(['token-1', 'token-1']);
    expect(siteverifyCalls).toBe(1);
  });

  /**
   * The guard redeems a nonce with `GETDEL`, so two proofs signed over the same one cannot
   * both be accepted. Turnstile is switched off here because one widget hands out one token
   * and a burst could not carry one each — the nonce is what is under test.
   */
  it('lets a concurrent burst through, at the cost of one shared handshake', async () => {
    server.use(apiHandler({ turnstileRequired: false }));
    const api = client();

    const responses = await Promise.all([
      api.post(API_URL),
      api.post(API_URL),
      api.post(API_URL),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(attempts).toHaveLength(4);
    expect($hasProvenKey.get()).toBe(true);
  });

  it('needs no further handshake once a nonce is in hand', async () => {
    setTurnstileToken('token-1');
    const api = client();

    await api.post(API_URL);
    setTurnstileToken('token-2');
    await api.post(API_URL);

    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.turnstile).toBe('token-2');
  });

  // `readChallengeError` keys off this exact shape. If either side restyles the header,
  // the client silently stops recognising a handshake and starts reporting lost sessions.
  it('spends a nonce once, and says so in a challenge the client parses', async () => {
    setTurnstileToken('token-1');
    await client().post(API_URL);

    const spent = attempts.at(-1)?.dpop ?? '';
    const replayed = await fetch(API_URL, {
      method: 'POST',
      headers: { [MITA_HEADERS.dpop]: spent, [MITA_HEADERS.turnstile]: 'token-2' },
    });

    expect(replayed.status).toBe(401);
    expect(replayed.headers.get('www-authenticate')).toMatch(/^DPoP error="use_dpop_nonce"/);
    expect(replayed.headers.get(MITA_HEADERS.dpopNonce)).not.toBeNull();
  });

  it('challenges a request carrying no proof as an invalid one', async () => {
    const unproven = await fetch(API_URL, {
      method: 'POST',
      headers: { [MITA_HEADERS.turnstile]: 'token-1' },
    });

    expect(unproven.status).toBe(401);
    expect(unproven.headers.get('www-authenticate')).toMatch(/^DPoP error="invalid_dpop_proof"/);
  });

  it('surfaces a rate limit rejection before anything is spent', async () => {
    rateLimitRemaining = -1;
    setTurnstileToken('token-1');

    const failure = await client().post(API_URL).catch((cause: unknown) => cause);

    expect(isHTTPError(failure) && failure.response.status).toBe(429);
    expect(attempts).toHaveLength(1);
    expect(siteverifyCalls).toBe(0);
  });

  it('reports a refused Turnstile token as forbidden, not as a lost session', async () => {
    server.use(siteverifyHandler(false));
    setTurnstileToken('token-1');
    const onUnauthorized = vi.fn();

    const failure = await client({ onUnauthorized }).post(API_URL).catch((cause: unknown) => cause);

    expect(isHTTPError(failure) && failure.response.status).toBe(403);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
