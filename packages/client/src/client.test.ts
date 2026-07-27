/**
 * @vitest-environment node
 *
 * `createProtectedClient` touches no DOM. Running it under happy-dom would put that
 * package's fetch and same-origin emulation between the test and msw, which is neither
 * what ships to browsers nor what is under test here.
 */
import { MITA_HEADERS, generateDPoPKeyPair, verifyDPoP, type DPoPKeyPair } from '@mita-auth/core';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProtectedClient } from './client';
// Reached through this package's own re-export, the way a consumer is meant to: ky is
// not something an application should have to install to read a failure.
import { isHTTPError } from './ky';
import { $hasProvenKey, $turnstileStatus, resetMitaState, setTurnstileToken } from './state';

const API_URL = 'https://api.test/comments';

const server = setupServer();

let keyPair: DPoPKeyPair;
let attempts: Array<{ proof: string; turnstile: string | null }>;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  keyPair = await generateDPoPKeyPair();
});

beforeEach(() => {
  attempts = [];
  resetMitaState();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

/** Answers with each response in turn, repeating the last one once the list runs out. */
function queue(...responses: Array<() => Response>) {
  let index = 0;

  return http.all(API_URL, ({ request }) => {
    attempts.push({
      proof: request.headers.get(MITA_HEADERS.dpop) ?? '',
      turnstile: request.headers.get(MITA_HEADERS.turnstile),
    });

    const respond = responses[Math.min(index, responses.length - 1)];
    index += 1;

    return respond?.();
  });
}

function accepted(nonce?: string) {
  return HttpResponse.json({ ok: true }, nonce === undefined ? {} : { headers: nonceHeader(nonce) });
}

function nonceChallenge(nonce: string) {
  return challenge('use_dpop_nonce', 'dpop_nonce_required', nonceHeader(nonce));
}

function invalidProof() {
  return challenge('invalid_dpop_proof', 'dpop_invalid');
}

function challenge(error: string, reason: string, headers: Record<string, string> = {}) {
  return HttpResponse.json(
    { error: reason },
    {
      status: 401,
      headers: { 'www-authenticate': `DPoP error="${error}", algs="ES256"`, ...headers },
    },
  );
}

function nonceHeader(nonce: string) {
  return { [MITA_HEADERS.dpopNonce]: nonce };
}

/**
 * Stands in for the server's nonce store, whose defining trait is that a nonce is redeemed
 * exactly once. A handler that kept accepting the same one would let every concurrency bug
 * in this file pass.
 */
function nonceStore() {
  const live = new Set<string>();
  let issued = 0;

  return http.all(API_URL, async ({ request }) => {
    const proof = request.headers.get(MITA_HEADERS.dpop) ?? '';
    attempts.push({ proof, turnstile: request.headers.get(MITA_HEADERS.turnstile) });

    const { nonce } = await verifyDPoP(proof, { method: request.method, url: API_URL });
    const redeemed = nonce !== undefined && live.delete(nonce);

    issued += 1;
    const replacement = `nonce-${issued}`;
    live.add(replacement);

    return redeemed
      ? accepted(replacement)
      : challenge('use_dpop_nonce', 'dpop_nonce_required', nonceHeader(replacement));
  });
}

/** Retry delays are irrelevant to what is under test and would only slow the suite. */
function client(options: Parameters<typeof createProtectedClient>[0] = {}) {
  return createProtectedClient({ keyPair, retry: { delay: () => 0 }, ...options });
}

function proofAt(index: number, method = 'POST') {
  return verifyDPoP(attempts[index]?.proof ?? '', { method, url: API_URL });
}

/**
 * A round trip slow enough to be measured, standing in for the network so the saturation
 * check has elapsed wall-clock time to weigh rather than a same-tick answer. Paired with
 * {@link SATURATED_TIMEOUT_MS} it puts one queued request inside the budget and the next
 * one outside it, with the lower bound guaranteed — a timer never fires early.
 */
const SLOW_RTT_MS = 120;
const SATURATED_TIMEOUT_MS = 200;

function slowNetwork() {
  let issued = 0;

  return vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_RTT_MS));
    issued += 1;

    return accepted(`nonce-${issued}`);
  });
}

describe('createProtectedClient', () => {
  it('rejects a nonsensical retry limit', () => {
    expect(() => createProtectedClient({ nonceRetryLimit: -1 })).toThrow(
      /non-negative integer/,
    );
  });

  // ky would refuse the handshake retry and throw a forced-retry error carrying neither a
  // status code nor a callback, which is close to undiagnosable from the outside.
  it('rejects a ky retry budget too small for the handshake', () => {
    expect(() => createProtectedClient({ retry: 0 })).toThrow(/retry\.limit/);
    expect(() => createProtectedClient({ nonceRetryLimit: 2, retry: { limit: 1 } })).toThrow(
      /retry\.limit/,
    );
  });

  it('sends through a caller-supplied fetch', async () => {
    server.use(queue(() => accepted('nonce-1')));
    const sent = vi.fn();

    await client({
      fetch: async (input, init) => {
        sent();
        return globalThis.fetch(input, init);
      },
    })
      .post(API_URL)
      .json();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(attempts[0]?.proof).not.toBe('');
  });

  // ky lets a single call override `fetch`, and before the saturation check moved the
  // binding into the init hook that override silently replaced the signing path outright.
  it('signs through a fetch supplied for one call', async () => {
    server.use(queue(() => accepted('nonce-1')));
    const sent = vi.fn();

    await client()
      .post(API_URL, {
        fetch: async (input, init) => {
          sent();
          return globalThis.fetch(input, init);
        },
      })
      .json();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(attempts[0]?.proof).not.toBe('');
  });

  describe('dpop proofs', () => {
    it('binds a proof to the request it is sent with', async () => {
      server.use(queue(() => accepted('nonce-1')));

      await client().post(API_URL).json();
      const proof = await proofAt(0);

      expect(proof.htm).toBe('POST');
      expect(proof.htu).toBe(API_URL);
      expect(proof.nonce).toBeUndefined();
    });

    it('echoes the issued nonce on the following request', async () => {
      server.use(queue(() => accepted('nonce-1'), () => accepted('nonce-2')));

      const api = client();
      await api.post(API_URL).json();
      await api.post(API_URL).json();

      expect((await proofAt(1)).nonce).toBe('nonce-1');
    });

    it('signs a fresh proof for a backoff retry, since a jti is single-use', async () => {
      server.use(queue(() => HttpResponse.json({}, { status: 503 }), () => accepted('nonce-1')));

      await client().get(API_URL).json();
      const [first, second] = await Promise.all([proofAt(0, 'GET'), proofAt(1, 'GET')]);

      expect(attempts).toHaveLength(2);
      expect(second.jti).not.toBe(first.jti);
    });
  });

  describe('nonce handshake', () => {
    it('resolves a cold start by re-signing with the offered nonce', async () => {
      server.use(queue(() => nonceChallenge('nonce-1'), () => accepted('nonce-2')));

      const response = await client().post(API_URL);
      const [first, second] = await Promise.all([proofAt(0), proofAt(1)]);

      expect(response.status).toBe(200);
      expect(attempts).toHaveLength(2);
      expect(first.nonce).toBeUndefined();
      expect(second.nonce).toBe('nonce-1');
      expect(second.jti).not.toBe(first.jti);
    });

    it('gives up rather than chasing a server that keeps asking for a nonce', async () => {
      server.use(queue(() => nonceChallenge('nonce-1'), () => nonceChallenge('nonce-2')));
      const onUnauthorized = vi.fn();

      await expect(client({ onUnauthorized }).post(API_URL)).rejects.toThrow();

      expect(attempts).toHaveLength(2);
      expect(onUnauthorized).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'nonce_exhausted' }),
      );
    });

    it('honours a raised retry limit', async () => {
      server.use(
        queue(
          () => nonceChallenge('nonce-1'),
          () => nonceChallenge('nonce-2'),
          () => accepted('nonce-3'),
        ),
      );

      const response = await client({ nonceRetryLimit: 2, retry: { limit: 3, delay: () => 0 } })
        .post(API_URL);

      expect(response.status).toBe(200);
      expect(attempts).toHaveLength(3);
      expect((await proofAt(2)).nonce).toBe('nonce-2');
    });

    it('does not handshake at all when the limit is zero', async () => {
      server.use(queue(() => nonceChallenge('nonce-1')));

      await expect(client({ nonceRetryLimit: 0 }).post(API_URL)).rejects.toThrow();

      expect(attempts).toHaveLength(1);
    });

    // A 503 eats one of ky's attempts before the handshake ever starts, so a budget that was
    // large enough at construction time can still run out mid-call.
    it('reports a ky budget spent mid-call as a 401, not as a forced retry', async () => {
      server.use(
        queue(
          () => HttpResponse.json({}, { status: 503 }),
          () => nonceChallenge('nonce-1'),
          () => nonceChallenge('nonce-2'),
          () => nonceChallenge('nonce-3'),
        ),
      );
      const onUnauthorized = vi.fn();

      const failure = await client({
        nonceRetryLimit: 3,
        retry: { limit: 3, delay: () => 0 },
        onUnauthorized,
      })
        .get(API_URL)
        .catch((cause: unknown) => cause);

      expect(isHTTPError(failure) && failure.response.status).toBe(401);
      expect(onUnauthorized).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'nonce_exhausted' }),
      );
    });
  });

  /**
   * A nonce is redeemed once, so attempts that sign over the same one cannot both be
   * accepted. These lock the behaviour that made every concurrent request but one fail:
   * attempts queue, and each signs over what the one before it brought back.
   */
  describe('concurrent calls', () => {
    it('lets a cold-start burst through, every one of them', async () => {
      server.use(nonceStore());
      const api = client();

      const responses = await Promise.all([
        api.post(API_URL),
        api.post(API_URL),
        api.post(API_URL),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
      expect($hasProvenKey.get()).toBe(true);
    });

    it('spends one handshake for the burst, not one per request', async () => {
      server.use(nonceStore());
      const api = client();

      await Promise.all([api.post(API_URL), api.post(API_URL), api.post(API_URL)]);

      // Three calls plus the single cold start that RFC 9449 makes unavoidable. Anything
      // higher means requests are being retried against a nonce someone else had taken.
      expect(attempts).toHaveLength(4);
    });

    it('adds no round trips at all once a nonce is in hand', async () => {
      server.use(nonceStore());
      const api = client();

      await api.post(API_URL);
      attempts.length = 0;
      await Promise.all([api.post(API_URL), api.post(API_URL), api.post(API_URL)]);

      expect(attempts).toHaveLength(3);
    });

    /**
     * ky's per-attempt timer is already running while an attempt waits its turn, so a deep
     * enough burst would have its tail reported as a `TimeoutError` for requests that were
     * never sent. These lock the diagnosable refusal that replaces it.
     */
    it('refuses an attempt the timeout cannot cover, and never sends it', async () => {
      const network = slowNetwork();
      const api = client({ timeout: SATURATED_TIMEOUT_MS, fetch: network });

      // Nothing to predict until a round trip has been observed.
      await api.post(API_URL);

      const [first, second] = await Promise.allSettled([api.post(API_URL), api.post(API_URL)]);

      expect(first).toMatchObject({ status: 'fulfilled' });
      expect(second).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'client.queue_saturated' }),
      });
      expect(network).toHaveBeenCalledTimes(2);
    });

    it('leaves the queue open once the burst has drained', async () => {
      const api = client({ timeout: SATURATED_TIMEOUT_MS, fetch: slowNetwork() });

      await api.post(API_URL);
      await Promise.allSettled([api.post(API_URL), api.post(API_URL)]);

      await expect(api.post(API_URL)).resolves.toMatchObject({ status: 200 });
    });

    // `timeout` is a per-call option. Weighing the queue against the instance's value would
    // refuse a call that had asked for — and had — sixty seconds to finish in.
    it('weighs a call against the timeout that call actually asked for', async () => {
      const api = client({ timeout: SATURATED_TIMEOUT_MS, fetch: slowNetwork() });

      await api.post(API_URL);

      const responses = await Promise.all([
        api.post(API_URL, { timeout: 60_000 }),
        api.post(API_URL, { timeout: 60_000 }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
    });

    it('predicts nothing when there is no timeout to run out of', async () => {
      const api = client({ timeout: false, fetch: slowNetwork() });

      await api.post(API_URL);
      const responses = await Promise.all([api.post(API_URL), api.post(API_URL)]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
    });
  });

  describe('unauthorized', () => {
    it('does not retry a proof the server called invalid', async () => {
      server.use(queue(invalidProof));
      const onUnauthorized = vi.fn();

      await expect(client({ onUnauthorized }).post(API_URL)).rejects.toThrow();

      expect(attempts).toHaveLength(1);
      expect(onUnauthorized).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'invalid_dpop_proof' }),
      );
    });

    it('reports a 401 carrying no DPoP challenge as merely unauthorized', async () => {
      server.use(queue(() => HttpResponse.json({ error: 'nope' }, { status: 401 })));
      const onUnauthorized = vi.fn();

      await expect(client({ onUnauthorized }).post(API_URL)).rejects.toThrow();

      expect(onUnauthorized).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unauthorized' }),
      );
    });

    it('leaves other rejections to the caller', async () => {
      server.use(queue(() => HttpResponse.json({ error: 'turnstile_rejected' }, { status: 403 })));
      const onUnauthorized = vi.fn();

      await expect(client({ onUnauthorized }).post(API_URL)).rejects.toThrow();

      expect(onUnauthorized).not.toHaveBeenCalled();
    });
  });

  describe('session state', () => {
    it('turns authenticated once a proof has been accepted', async () => {
      server.use(queue(() => accepted('nonce-1')));

      await client().post(API_URL).json();

      expect($hasProvenKey.get()).toBe(true);
    });

    // Only a server that ran the DPoP path hands back a nonce, so a plain 200 proves
    // nothing about this browser's key pair.
    it('stays unauthenticated when the server issued no nonce', async () => {
      server.use(queue(() => accepted()));

      await client().post(API_URL).json();

      expect($hasProvenKey.get()).toBe(false);
    });

    // `state.ts` reserves `unauthorized` for a rejection retrying cannot fix. A spent
    // handshake budget is not one: the next request signs over the nonce this one issued.
    it('keeps the session when only the handshake budget ran out', async () => {
      server.use(
        queue(
          () => accepted('nonce-1'),
          () => nonceChallenge('nonce-2'),
          () => nonceChallenge('nonce-3'),
        ),
      );
      const onUnauthorized = vi.fn();
      const api = client({ onUnauthorized });

      await api.post(API_URL).json();
      await expect(api.post(API_URL)).rejects.toThrow();

      expect(onUnauthorized).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'nonce_exhausted' }),
      );
      expect($hasProvenKey.get()).toBe(true);
    });

    it('drops authentication when a proof is rejected', async () => {
      server.use(queue(() => accepted('nonce-1'), invalidProof));

      const api = client();
      await api.post(API_URL).json();
      await expect(api.post(API_URL)).rejects.toThrow();

      expect($hasProvenKey.get()).toBe(false);
    });
  });

  describe('turnstile', () => {
    it('sends the stored token and marks it spent', async () => {
      server.use(queue(() => accepted('nonce-1')));
      setTurnstileToken('token-1');

      await client().post(API_URL).json();

      expect(attempts[0]?.turnstile).toBe('token-1');
      expect($turnstileStatus.get()).toBe('spent');
    });

    // The server defers siteverify until the proof passes, so the token survives the
    // handshake. Fetching a second one would need the visitor to solve another challenge.
    it('carries the same token through the nonce handshake', async () => {
      server.use(queue(() => nonceChallenge('nonce-1'), () => accepted('nonce-2')));
      setTurnstileToken('token-1');

      await client().post(API_URL).json();

      expect(attempts.map((attempt) => attempt.turnstile)).toEqual(['token-1', 'token-1']);
    });

    it('sends no token header when the widget has none', async () => {
      server.use(queue(() => accepted('nonce-1')));

      await client().post(API_URL).json();

      expect(attempts[0]?.turnstile).toBeNull();
    });

    it('leaves the token alone when turnstile is disabled', async () => {
      server.use(queue(() => accepted('nonce-1')));
      setTurnstileToken('token-1');

      await client({ turnstile: false }).post(API_URL).json();

      expect(attempts[0]?.turnstile).toBeNull();
      expect($turnstileStatus.get()).toBe('solved');
    });
  });

  describe('caller hooks', () => {
    it('signs after the caller has finished rewriting the request', async () => {
      server.use(queue(() => accepted('nonce-1')));
      const seen = vi.fn();

      await client({
        hooks: {
          beforeRequest: [
            ({ request }) => {
              seen(request.headers.get(MITA_HEADERS.dpop));
            },
          ],
        },
      })
        .post(API_URL)
        .json();

      expect(seen).toHaveBeenCalledWith(null);
      expect(attempts[0]?.proof).not.toBe('');
    });

    it('runs caller afterResponse hooks once the nonce has been taken', async () => {
      server.use(queue(() => accepted('nonce-1'), () => accepted('nonce-2')));
      const seen = vi.fn();

      const api = client({
        hooks: {
          afterResponse: [
            ({ response }) => {
              seen(response.headers.get(MITA_HEADERS.dpopNonce));
            },
          ],
        },
      });

      await api.post(API_URL).json();
      await api.post(API_URL).json();

      expect(seen).toHaveBeenNthCalledWith(1, 'nonce-1');
      expect((await proofAt(1)).nonce).toBe('nonce-1');
    });
  });
});
