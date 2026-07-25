import { generateDPoPKeyPair, generateNonce, signDPoP, type DPoPKeyPair } from '@mita/core';
import { Redis } from '@upstash/redis';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createSecurityGuard, type CreateSecurityGuardOptions } from './guard';
import { TURNSTILE_SITEVERIFY_ENDPOINT } from './turnstile';

const REDIS_URL = 'https://guard.upstash.test';
const PIPELINE_ENDPOINT = `${REDIS_URL}/pipeline`;
const REQUEST_URL = 'https://api.test/comments';
const TURNSTILE_TOKEN = 'turnstile-token';

type Command = [string, ...unknown[]];

const server = setupServer();

let keyPair: DPoPKeyPair;
let sent: Command[];
let siteverifyCalls: Mock<() => void>;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  keyPair = await generateDPoPKeyPair();
});

beforeEach(() => {
  sent = [];
  siteverifyCalls = vi.fn<() => void>();
  server.use(redisHandler(), siteverifyHandler(true));
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

/**
 * Stands in for Upstash. `evalsha` is the rate-limit script, `getdel` redeems a nonce,
 * `set` either claims a jti (with `nx`) or records a freshly issued nonce.
 */
function redisHandler(
  replies: {
    evalsha?: unknown;
    getdel?: unknown;
    claimJti?: unknown;
    issueNonce?: unknown;
  } = {},
) {
  return http.post(PIPELINE_ENDPOINT, async ({ request }) => {
    const commands = JSON.parse(await request.text()) as Command[];
    sent.push(...commands);

    // `null` is a meaningful Redis reply here, so fall back on absence, not on nullishness.
    const reply = <TKey extends keyof typeof replies>(key: TKey, fallback: unknown) =>
      key in replies ? replies[key] : fallback;

    return HttpResponse.json(
      commands.map((command) => {
        switch (command[0]) {
          case 'evalsha':
            return { result: reply('evalsha', [9, 10]) };
          case 'getdel':
            return { result: reply('getdel', 1) };
          default:
            return {
              result: command.includes('nx')
                ? reply('claimJti', 'OK')
                : reply('issueNonce', 'OK'),
            };
        }
      }),
    );
  });
}

/** Serves the defaults until the nth Redis round trip, which then errors. */
function redisFailingAt(failingCall: number) {
  let calls = 0;

  return http.post(PIPELINE_ENDPOINT, async ({ request }) => {
    const commands = JSON.parse(await request.text()) as Command[];
    sent.push(...commands);
    calls += 1;

    if (calls === failingCall) {
      return HttpResponse.json({ error: 'boom' }, { status: 500 });
    }

    return HttpResponse.json(
      commands.map((command) => ({
        result: command[0] === 'evalsha' ? [9, 10] : command[0] === 'getdel' ? 1 : 'OK',
      })),
    );
  });
}

function siteverifyHandler(success: boolean, init?: ResponseInit) {
  return http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () => {
    siteverifyCalls();
    return HttpResponse.json(
      { success, challenge_ts: new Date().toISOString(), hostname: 'example.com' },
      init,
    );
  });
}

function guard(options: Partial<CreateSecurityGuardOptions> = {}) {
  return createSecurityGuard({
    redis: new Redis({ url: REDIS_URL, token: 'test-token', retry: false }),
    ...options,
  });
}

/** Passing `nonce: undefined` explicitly signs a proof with no nonce claim at all. */
async function dpopRequest(
  overrides: { nonce?: string | undefined; method?: string; url?: string } = {},
) {
  const { method = 'POST', url = REQUEST_URL } = overrides;
  const nonce = 'nonce' in overrides ? overrides.nonce : generateNonce();
  const proof = await signDPoP(keyPair, {
    method,
    url,
    ...(nonce === undefined ? {} : { nonce }),
  });

  return new Request(REQUEST_URL, {
    method: 'POST',
    headers: {
      dpop: proof,
      'cf-connecting-ip': '198.51.100.1',
      'x-mita-turnstile': TURNSTILE_TOKEN,
    },
  });
}

function plainRequest(headers: Record<string, string> = {}) {
  return new Request(REQUEST_URL, {
    method: 'POST',
    headers: { 'cf-connecting-ip': '198.51.100.1', ...headers },
  });
}

function commandNames() {
  return sent.map((command) => command[0]);
}

describe('rate limiting', () => {
  it('lets a request inside the window through', async () => {
    const check = await guard().verify(plainRequest());

    expect(check).toMatchObject({ success: true, identifier: '198.51.100.1' });
  });

  it('answers 429 with retry hints once the window is spent', async () => {
    server.use(redisHandler({ evalsha: [-1, 10] }));

    const check = await guard().verify(plainRequest());

    expect(check.success).toBe(false);
    if (check.success) return;

    expect(check.reason).toBe('rate_limited');
    expect(check.response.status).toBe(429);
    expect(check.response.headers.get('ratelimit-limit')).toBe('10');
    expect(check.response.headers.get('retry-after')).not.toBeNull();
  });

  // Rate limiting is the cheapest check precisely so hostile traffic never reaches the
  // ones that cost a Cloudflare round trip or a signature verification.
  it('short-circuits before Turnstile and the replay store', async () => {
    server.use(redisHandler({ evalsha: [-1, 10] }));

    await guard({ turnstile: { secretKey: 'secret' }, dpop: true }).verify(
      await dpopRequest(),
    );

    expect(siteverifyCalls).not.toHaveBeenCalled();
    expect(commandNames()).toEqual(['evalsha']);
  });

  it('answers 503 rather than 429 when the limiter could not decide', async () => {
    server.use(
      http.post(PIPELINE_ENDPOINT, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );

    const check = await guard({ rateLimit: { failureMode: 'closed' } }).verify(plainRequest());

    expect(check).toMatchObject({ success: false, reason: 'rate_limit_unavailable' });
    expect(check.success || check.response.status).toBe(503);
  });
});

describe('turnstile', () => {
  it('rejects a request carrying no token', async () => {
    const check = await guard({ turnstile: { secretKey: 'secret' } }).verify(plainRequest());

    expect(check).toMatchObject({ success: false, reason: 'turnstile_missing' });
    expect(check.success || check.response.status).toBe(403);
  });

  it('lets an absent token through when it is optional', async () => {
    const check = await guard({
      turnstile: { secretKey: 'secret', required: false },
    }).verify(plainRequest());

    expect(check.success).toBe(true);
    expect(siteverifyCalls).not.toHaveBeenCalled();
  });

  it('rejects a token Cloudflare refuses', async () => {
    server.use(siteverifyHandler(false));

    const check = await guard({ turnstile: { secretKey: 'secret' } }).verify(
      plainRequest({ 'x-mita-turnstile': TURNSTILE_TOKEN }),
    );

    expect(check).toMatchObject({ success: false, reason: 'turnstile_rejected' });
    expect(check.success || check.response.status).toBe(403);
  });

  it('surfaces the verified challenge on success', async () => {
    const check = await guard({ turnstile: { secretKey: 'secret' } }).verify(
      plainRequest({ 'x-mita-turnstile': TURNSTILE_TOKEN }),
    );

    expect(check.success && check.turnstile?.hostname).toBe('example.com');
  });

  // Failing open here would hand a bypass to anyone able to blackhole siteverify.
  it('fails closed when siteverify is unreachable', async () => {
    server.use(siteverifyHandler(true, { status: 500 }));

    const check = await guard({ turnstile: { secretKey: 'secret' } }).verify(
      plainRequest({ 'x-mita-turnstile': TURNSTILE_TOKEN }),
    );

    expect(check).toMatchObject({ success: false, reason: 'turnstile_unavailable' });
    expect(check.success || check.response.status).toBe(503);
  });

  it('can be configured to fail open instead', async () => {
    server.use(siteverifyHandler(true, { status: 500 }));

    const check = await guard({
      turnstile: { secretKey: 'secret', failureMode: 'open' },
    }).verify(plainRequest({ 'x-mita-turnstile': TURNSTILE_TOKEN }));

    expect(check.success).toBe(true);
  });

  it('runs before the replay store', async () => {
    server.use(siteverifyHandler(false));

    await guard({ turnstile: { secretKey: 'secret' }, dpop: true }).verify(await dpopRequest());

    expect(commandNames()).toEqual(['evalsha']);
  });
});

describe('dpop', () => {
  it('accepts a fresh proof and hands back the next nonce', async () => {
    const check = await guard({ dpop: true }).verify(await dpopRequest());

    expect(check.success).toBe(true);
    if (!check.success) return;

    expect(check.proof?.htu).toBe(REQUEST_URL);
    expect(check.headers.get('dpop-nonce')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(commandNames()).toEqual(['evalsha', 'getdel', 'set', 'set']);
  });

  it('challenges a request with no proof', async () => {
    const check = await guard({ dpop: true }).verify(plainRequest());

    expect(check).toMatchObject({ success: false, reason: 'dpop_missing' });
    if (check.success) return;

    expect(check.response.status).toBe(401);
    expect(check.response.headers.get('www-authenticate')).toContain('DPoP');
    expect(check.response.headers.get('dpop-nonce')).not.toBeNull();
  });

  it('lets an absent proof through when it is optional', async () => {
    const check = await guard({ dpop: { required: false } }).verify(plainRequest());

    expect(check.success).toBe(true);
  });

  it('rejects a proof bound to another method', async () => {
    const proof = await signDPoP(keyPair, { method: 'GET', url: REQUEST_URL, nonce: generateNonce() });
    const request = new Request(REQUEST_URL, { method: 'POST', headers: { dpop: proof } });

    const check = await guard({ dpop: true }).verify(request);

    expect(check).toMatchObject({ success: false, reason: 'dpop_invalid' });
    expect(check.success || check.response.status).toBe(401);
  });

  it('rejects a malformed proof', async () => {
    const request = new Request(REQUEST_URL, { method: 'POST', headers: { dpop: 'not-a-jwt' } });

    const check = await guard({ dpop: true }).verify(request);

    expect(check).toMatchObject({ success: false, reason: 'dpop_invalid' });
  });

  // The nonce is opaque and unsigned, so only the store can rule on it.
  it('demands a nonce when the proof carries none', async () => {
    const check = await guard({ dpop: true }).verify(await dpopRequest({ nonce: undefined }));

    expect(check).toMatchObject({ success: false, reason: 'dpop_nonce_required' });
    if (check.success) return;

    expect(check.response.headers.get('www-authenticate')).toContain('use_dpop_nonce');
    expect(check.response.headers.get('dpop-nonce')).not.toBeNull();
  });

  it('demands a new nonce when the presented one is unknown or already spent', async () => {
    server.use(redisHandler({ getdel: null }));

    const check = await guard({ dpop: true }).verify(await dpopRequest());

    expect(check).toMatchObject({ success: false, reason: 'dpop_nonce_required' });
    expect(check.success || check.response.headers.get('dpop-nonce')).not.toBeNull();
  });

  it('rejects a replayed proof identifier', async () => {
    server.use(redisHandler({ claimJti: null }));

    const check = await guard({ dpop: true }).verify(await dpopRequest());

    expect(check).toMatchObject({ success: false, reason: 'dpop_replayed' });
    expect(check.success || check.response.status).toBe(401);
  });

  it('answers 503 when the replay store cannot be reached', async () => {
    let calls = 0;
    server.use(
      http.post(PIPELINE_ENDPOINT, async ({ request }) => {
        const commands = JSON.parse(await request.text()) as Command[];
        calls += 1;

        // Let the rate-limit call through, then take the store down.
        return calls === 1
          ? HttpResponse.json(commands.map(() => ({ result: [9, 10] })))
          : HttpResponse.json({ error: 'boom' }, { status: 500 });
      }),
    );

    const check = await guard({ dpop: true }).verify(await dpopRequest());

    expect(check).toMatchObject({ success: false, reason: 'store_unavailable' });
    expect(check.success || check.response.status).toBe(503);
  });

  // A misconfiguration is not a failed proof; disguising it as a 401 would send the
  // client into an unwinnable retry loop over a bug only the operator can fix.
  it('rethrows an error that is not a proof rejection', async () => {
    const guarded = guard({ dpop: true, resolveUrl: () => 'not-an-absolute-url' });

    await expect(guarded.verify(await dpopRequest())).rejects.toThrow();
  });

  it('answers 503 when no nonce can be minted for the challenge', async () => {
    // Commands run one per request: 1 is the rate-limit script, 2 issues the nonce.
    server.use(redisFailingAt(2));

    const check = await guard({ dpop: true }).verify(plainRequest());

    expect(check).toMatchObject({ success: false, reason: 'store_unavailable' });
    expect(check.success || check.response.status).toBe(503);
  });

  // The proof itself was fine, but without a follow-up nonce the client cannot continue.
  it('answers 503 when the next nonce cannot be issued after a valid proof', async () => {
    // 1 rate limit, 2 redeem nonce, 3 claim jti, 4 issue the next nonce.
    server.use(redisFailingAt(4));

    const check = await guard({ dpop: true }).verify(await dpopRequest());

    expect(check).toMatchObject({ success: false, reason: 'store_unavailable' });
  });

  it('binds the proof to the public URL when a proxy rewrote it', async () => {
    const proof = await signDPoP(keyPair, {
      method: 'POST',
      url: 'https://public.test/comments',
      nonce: generateNonce(),
    });
    const request = new Request('https://internal.test/comments', {
      method: 'POST',
      headers: { dpop: proof },
    });

    const check = await guard({
      dpop: true,
      resolveUrl: () => 'https://public.test/comments',
    }).verify(request);

    expect(check.success).toBe(true);
  });

  it('remembers the jti for longer than a proof stays acceptable', async () => {
    await guard({ dpop: { maxAgeSeconds: 30, clockToleranceSeconds: 10 } }).verify(
      await dpopRequest(),
    );

    const claim = sent.find((command) => command.includes('nx'));

    expect(claim).toContain(50_000);
  });
});

describe('composition', () => {
  it('accepts a plain redis configuration object', async () => {
    const check = await guard({ redis: { url: REDIS_URL, token: 'test-token' } }).verify(
      plainRequest(),
    );

    expect(check.success).toBe(true);
  });

  it('runs every check in order when all are enabled', async () => {
    const check = await guard({
      turnstile: { secretKey: 'secret' },
      dpop: true,
    }).verify(await dpopRequest());

    expect(check.success).toBe(true);
    expect(siteverifyCalls).toHaveBeenCalledOnce();
    expect(commandNames()).toEqual(['evalsha', 'getdel', 'set', 'set']);
  });

  it('forwards the DPoP store settings', async () => {
    const onUnavailable = vi.fn();

    await guard({
      dpop: { prefix: 'acme', nonceTtlMs: 45_000, timeoutMs: 2000, onUnavailable },
    }).verify(await dpopRequest());

    const issue = sent.find((command) => command[0] === 'set' && !command.includes('nx'));

    expect(issue?.[1]).toMatch(/^acme:nonce:/);
    expect(issue).toContain(45_000);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('forwards the Turnstile settings', async () => {
    const endpoint = 'https://siteverify.proxy.test/verify';
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({
          success: true,
          challenge_ts: new Date().toISOString(),
          hostname: 'elsewhere.test',
          action: 'comment',
        }),
      ),
    );

    const check = await guard({
      turnstile: {
        secretKey: 'secret',
        endpoint,
        allowedHostnames: ['example.com'],
        expectedAction: 'comment',
        maxAgeSeconds: 120,
      },
    }).verify(plainRequest({ 'x-mita-turnstile': TURNSTILE_TOKEN }));

    expect(check).toMatchObject({ success: false, reason: 'turnstile_rejected' });
  });

  it('exposes the underlying limiter and store', async () => {
    const instance = guard();

    expect(typeof instance.rateLimiter.limit).toBe('function');
    expect(typeof instance.replayStore.issueNonce).toBe('function');
  });
});
