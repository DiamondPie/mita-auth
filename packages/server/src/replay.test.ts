import { generateNonce } from '@mita/core';
import { Redis } from '@upstash/redis';
import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createReplayStore, type CreateReplayStoreOptions } from './replay';

const REDIS_URL = 'https://replay.upstash.test';
const PIPELINE_ENDPOINT = `${REDIS_URL}/pipeline`;

const JKT = 'w1TZFF5Cb4T5c1kNKhFhCcW9ZS8ZfmO3sYfCwyEBZAo';
const JTI = 'proof-identifier';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

type Command = [string, ...unknown[]];

/** Answers every pipelined command with `results`, recording what was sent. */
function upstash(results: unknown[], sent: Command[] = []) {
  return {
    sent,
    handler: http.post(PIPELINE_ENDPOINT, async ({ request }) => {
      const commands = JSON.parse(await request.text()) as Command[];
      sent.push(...commands);
      return HttpResponse.json(commands.map((_command, index) => ({ result: results[index] })));
    }),
  };
}

function failing(status = 500) {
  return http.post(PIPELINE_ENDPOINT, () => HttpResponse.json({ error: 'boom' }, { status }));
}

function store(options: Partial<CreateReplayStoreOptions> = {}) {
  return createReplayStore({
    redis: new Redis({ url: REDIS_URL, token: 'test-token', retry: false }),
    ...options,
  });
}

describe('issueNonce', () => {
  it('mints a nonce and records it with the configured lifetime', async () => {
    const { handler, sent } = upstash(['OK']);
    server.use(handler);

    const issued = await store({ nonceTtlMs: 60_000 }).issueNonce();

    expect(issued.ok).toBe(true);
    expect(issued.ok && issued.nonce.expiresAt).toBe(issued.ok ? issued.nonce.issuedAt + 60_000 : 0);
    expect(sent[0]).toEqual([
      'set',
      `mita:nonce:${issued.ok ? issued.nonce.value : ''}`,
      1,
      'px',
      60_000,
    ]);
  });

  it('namespaces keys with a custom prefix', async () => {
    const { handler, sent } = upstash(['OK']);
    server.use(handler);

    await store({ prefix: 'acme' }).issueNonce();

    expect(sent[0]?.[1]).toMatch(/^acme:nonce:/);
  });

  it('reports unavailability rather than handing out an unrecorded nonce', async () => {
    server.use(failing());
    const onUnavailable = vi.fn();

    const issued = await store({ onUnavailable }).issueNonce();

    expect(issued).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});

describe('consumeNonce', () => {
  const nonce = generateNonce();

  it('redeems a nonce that is still on record', async () => {
    const { handler, sent } = upstash([1]);
    server.use(handler);

    await expect(store().consumeNonce(nonce)).resolves.toEqual({ ok: true });
    expect(sent[0]).toEqual(['getdel', `mita:nonce:${nonce}`]);
  });

  // GETDEL reads and deletes atomically, so the second redemption sees nothing.
  it('refuses a nonce that was already redeemed', async () => {
    server.use(upstash([null]).handler);

    await expect(store().consumeNonce(nonce)).resolves.toEqual({
      ok: false,
      reason: 'unknown_nonce',
    });
  });

  it.each(['', 'short', 'not/base64url!'])('rejects the malformed nonce %o without a round trip', async (value) => {
    const handler = vi.fn();
    server.use(
      http.post(PIPELINE_ENDPOINT, () => {
        handler();
        return HttpResponse.json([{ result: 1 }]);
      }),
    );

    await expect(store().consumeNonce(value)).resolves.toEqual({
      ok: false,
      reason: 'unknown_nonce',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('denies the request when Redis cannot answer', async () => {
    server.use(failing());
    const onUnavailable = vi.fn();

    const check = await store({ onUnavailable }).consumeNonce(nonce);

    expect(check).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('gives up once the timeout budget is spent', async () => {
    server.use(
      http.post(PIPELINE_ENDPOINT, async () => {
        await delay(300);
        return HttpResponse.json([{ result: 1 }]);
      }),
    );

    await expect(store({ timeoutMs: 20 }).consumeNonce(nonce)).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('rememberProof', () => {
  it('claims an unseen jti with SET NX', async () => {
    const { handler, sent } = upstash(['OK']);
    server.use(handler);

    await expect(store().rememberProof({ jti: JTI, jkt: JKT })).resolves.toEqual({ ok: true });
    expect(sent[0]).toEqual(['set', `mita:jti:${JKT}:${JTI}`, 1, 'nx', 'px', 70_000]);
  });

  // The scope keeps one client's jti choices from locking out another's.
  it('scopes the jti to the proof key thumbprint', async () => {
    const { handler, sent } = upstash(['OK', 'OK']);
    server.use(handler);
    const replayStore = store();

    await replayStore.rememberProof({ jti: JTI, jkt: JKT });
    await replayStore.rememberProof({ jti: JTI, jkt: 'a-different-thumbprint' });

    expect(sent[0]?.[1]).not.toBe(sent[1]?.[1]);
  });

  it('reports a second claim as a replay', async () => {
    server.use(upstash([null]).handler);

    await expect(store().rememberProof({ jti: JTI, jkt: JKT })).resolves.toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('honours a per-call lifetime', async () => {
    const { handler, sent } = upstash(['OK']);
    server.use(handler);

    await store().rememberProof({ jti: JTI, jkt: JKT, ttlMs: 15_000 });

    expect(sent[0]).toContain(15_000);
  });

  it('honours the store-wide lifetime', async () => {
    const { handler, sent } = upstash(['OK']);
    server.use(handler);

    await store({ proofTtlMs: 90_000 }).rememberProof({ jti: JTI, jkt: JKT });

    expect(sent[0]).toContain(90_000);
  });

  // Failing open here would let a captured proof be replayed for as long as the outage lasts.
  it('denies the request when Redis cannot answer', async () => {
    server.use(failing());

    await expect(store().rememberProof({ jti: JTI, jkt: JKT })).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });
});
