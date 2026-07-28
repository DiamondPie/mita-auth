import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  TURNSTILE_SITEVERIFY_ENDPOINT,
  verifyTurnstileToken,
  type VerifyTurnstileTokenOptions,
} from './turnstile';

const SECRET_KEY = 'test-secret-key';
const TOKEN = 'valid-turnstile-token';
const SOLVED_AT = '2026-07-25T00:00:00.000Z';
const NOW = Date.parse(SOLVED_AT) + 1000;

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

/** Responds with a solved challenge, overridden field by field per test. */
function siteverify(body: Record<string, unknown>, init?: ResponseInit) {
  return http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () =>
    HttpResponse.json({ challenge_ts: SOLVED_AT, hostname: 'example.com', ...body }, init),
  );
}

function verify(options: Partial<VerifyTurnstileTokenOptions> = {}) {
  return verifyTurnstileToken({ secretKey: SECRET_KEY, token: TOKEN, now: NOW, ...options });
}

describe('verifyTurnstileToken', () => {
  it('accepts a token Cloudflare confirms', async () => {
    server.use(siteverify({ success: true, action: 'comment', cdata: 'post-42' }));

    await expect(verify()).resolves.toEqual({
      success: true,
      challenge: {
        hostname: 'example.com',
        action: 'comment',
        cdata: 'post-42',
        challengeTs: SOLVED_AT,
        ephemeralId: undefined,
      },
    });
  });

  it('surfaces the enterprise ephemeral id', async () => {
    server.use(siteverify({ success: true, metadata: { ephemeral_id: 'device-1' } }));

    const result = await verify();

    expect(result.success).toBe(true);
    expect(result.success && result.challenge.ephemeralId).toBe('device-1');
  });

  it('sends the secret, token and optional parameters as form data', async () => {
    const received = vi.fn<(body: string) => void>();
    server.use(
      http.post(TURNSTILE_SITEVERIFY_ENDPOINT, async ({ request }) => {
        received(await request.text());
        return HttpResponse.json({ success: true, challenge_ts: SOLVED_AT });
      }),
    );

    await verify({ remoteIp: '203.0.113.7', idempotencyKey: 'idem-1' });

    const body = new URLSearchParams(received.mock.calls[0]?.[0]);
    expect(Object.fromEntries(body)).toEqual({
      secret: SECRET_KEY,
      response: TOKEN,
      remoteip: '203.0.113.7',
      idempotency_key: 'idem-1',
    });
  });

  it('omits remoteip and idempotency_key when not supplied', async () => {
    const received = vi.fn<(body: string) => void>();
    server.use(
      http.post(TURNSTILE_SITEVERIFY_ENDPOINT, async ({ request }) => {
        received(await request.text());
        return HttpResponse.json({ success: true, challenge_ts: SOLVED_AT });
      }),
    );

    await verify();

    const body = new URLSearchParams(received.mock.calls[0]?.[0]);
    expect(body.has('remoteip')).toBe(false);
    expect(body.has('idempotency_key')).toBe(false);
  });

  it('rejects a malformed token without calling siteverify', async () => {
    const handler = vi.fn();
    server.use(
      http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () => {
        handler();
        return HttpResponse.json({ success: true });
      }),
    );

    await expect(verify({ token: '' })).resolves.toEqual({
      success: false,
      reason: 'rejected',
      errorCodes: ['invalid-input-response'],
      challenge: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });

  describe('rejections', () => {
    // The three that are genuinely about the visitor: a token missing, malformed, or already
    // spent. Everything else siteverify can say is about us.
    it.each(['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate'])(
      'reports %s as a rejection',
      async (code) => {
        server.use(siteverify({ success: false, 'error-codes': [code] }));

        const result = await verify();

        expect(result).toMatchObject({ success: false, reason: 'rejected', errorCodes: [code] });
      },
    );

    it('tolerates a failure without error-codes', async () => {
      server.use(siteverify({ success: false }));

      expect(await verify()).toMatchObject({ success: false, reason: 'rejected', errorCodes: [] });
    });

    it('drops non-string entries from error-codes', async () => {
      server.use(siteverify({ success: false, 'error-codes': ['invalid-input-response', 7, null] }));

      expect(await verify()).toMatchObject({ errorCodes: ['invalid-input-response'] });
    });
  });

  describe('unavailability', () => {
    // Cloudflare's own failure, documented as retryable, so it must not be reported as a
    // visitor rejection — and it is the one unavailability that does heal on its own.
    it('treats internal-error as unavailable without calling it a misconfiguration', async () => {
      server.use(siteverify({ success: false, 'error-codes': ['internal-error'] }));

      expect(await verify()).toEqual({
        success: false,
        reason: 'unavailable',
        errorCodes: ['internal-error'],
      });
    });

    /**
     * These three say the question was never asked: a secret key missing or wrong, or a
     * request Cloudflare could not parse. Reporting them as a rejection blames the visitor
     * for a deployment's typo; reporting them as a plain outage lets a fail-open caller wave
     * everyone through over one, and unlike an outage this does not heal.
     */
    it.each(['missing-input-secret', 'invalid-input-secret', 'bad-request'])(
      'treats %s as a misconfiguration',
      async (code) => {
        server.use(siteverify({ success: false, 'error-codes': [code] }));

        expect(await verify()).toEqual({
          success: false,
          reason: 'unavailable',
          errorCodes: [code],
          misconfigured: true,
        });
      },
    );

    // The shape Cloudflare actually answers with: a bad key is a 400, not a 200 carrying
    // `invalid-input-secret`. Classifying only after `response.ok` left the branch above
    // unreachable against the real endpoint, so the likeliest misconfiguration of all came
    // back as a plain outage that `failureMode: 'open'` was free to wave through.
    it.each(['missing-input-secret', 'invalid-input-secret'])(
      'reads %s out of the 400 it arrives on',
      async (code) => {
        server.use(siteverify({ success: false, 'error-codes': [code] }, { status: 400 }));

        expect(await verify()).toEqual({
          success: false,
          reason: 'unavailable',
          errorCodes: ['mita.http_error', code],
          misconfigured: true,
        });
      },
    );

    // Reading the body of a non-2xx must not turn into a verdict about the visitor: whatever
    // the codes say, nothing was judged.
    it('never lets a non-2xx become a rejection', async () => {
      server.use(
        siteverify({ success: false, 'error-codes': ['invalid-input-response'] }, { status: 400 }),
      );

      expect(await verify()).toEqual({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.http_error', 'invalid-input-response'],
      });
    });

    it('reports a failing body it cannot parse as the HTTP error alone', async () => {
      server.use(
        http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () =>
          HttpResponse.text('<html>Bad Gateway</html>', { status: 502 }),
        ),
      );

      expect(await verify()).toEqual({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.http_error'],
      });
    });

    it.each([500, 502, 429])('treats HTTP %i as unavailable', async (status) => {
      server.use(siteverify({ success: true }, { status }));

      expect(await verify()).toEqual({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.http_error'],
      });
    });

    it('treats a non-JSON body as unavailable', async () => {
      server.use(http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () => HttpResponse.text('<html>')));

      expect(await verify()).toMatchObject({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.malformed_response'],
      });
    });

    it('treats a non-object JSON body as unavailable', async () => {
      server.use(http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () => HttpResponse.json('nope')));

      expect(await verify()).toMatchObject({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.malformed_response'],
      });
    });

    it('treats a network error as unavailable', async () => {
      server.use(http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () => HttpResponse.error()));

      expect(await verify()).toMatchObject({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.network_error'],
      });
    });

    // Evaluated as an argument it would land in the same try as the fetch, and a runtime
    // without it would be reported as a network error — pointing whoever has to diagnose it
    // at Cloudflare rather than at the runtime.
    it('tells a runtime without AbortSignal.timeout apart from a network failure', async () => {
      const unsupported = new TypeError('AbortSignal.timeout is not a function');
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        throw unsupported;
      });

      try {
        expect(await verify()).toMatchObject({
          success: false,
          reason: 'unavailable',
          errorCodes: ['mita.runtime_unsupported'],
          cause: unsupported,
        });
      } finally {
        timeout.mockRestore();
      }
    });

    it('aborts once the timeout budget is spent', async () => {
      server.use(
        http.post(TURNSTILE_SITEVERIFY_ENDPOINT, async () => {
          await delay(200);
          return HttpResponse.json({ success: true, challenge_ts: SOLVED_AT });
        }),
      );

      expect(await verify({ timeoutMs: 20 })).toMatchObject({
        success: false,
        reason: 'unavailable',
        errorCodes: ['mita.network_error'],
      });
    });
  });

  describe('local checks Cloudflare recommends but does not perform', () => {
    it('rejects a hostname outside the allowlist', async () => {
      server.use(siteverify({ success: true, hostname: 'evil.example' }));

      expect(await verify({ allowedHostnames: ['example.com'] })).toMatchObject({
        reason: 'rejected',
        errorCodes: ['mita.hostname_mismatch'],
      });
    });

    it('accepts a hostname inside the allowlist', async () => {
      server.use(siteverify({ success: true }));

      expect(await verify({ allowedHostnames: ['other.test', 'example.com'] })).toMatchObject({
        success: true,
      });
    });

    it('rejects a missing hostname when an allowlist is configured', async () => {
      server.use(http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () =>
        HttpResponse.json({ success: true, challenge_ts: SOLVED_AT }),
      ));

      expect(await verify({ allowedHostnames: ['example.com'] })).toMatchObject({
        errorCodes: ['mita.hostname_mismatch'],
      });
    });

    it('skips the hostname check when no allowlist is configured', async () => {
      server.use(siteverify({ success: true, hostname: 'anything.test' }));

      expect(await verify()).toMatchObject({ success: true });
    });

    it('rejects a mismatched action', async () => {
      server.use(siteverify({ success: true, action: 'login' }));

      expect(await verify({ expectedAction: 'comment' })).toMatchObject({
        errorCodes: ['mita.action_mismatch'],
      });
    });

    it('accepts a matching action', async () => {
      server.use(siteverify({ success: true, action: 'comment' }));

      expect(await verify({ expectedAction: 'comment' })).toMatchObject({ success: true });
    });

    it('rejects a challenge solved longer ago than the maximum age', async () => {
      server.use(siteverify({ success: true }));

      expect(await verify({ now: Date.parse(SOLVED_AT) + 301_000 })).toMatchObject({
        errorCodes: ['mita.expired'],
      });
    });

    it('accepts a challenge exactly at the maximum age', async () => {
      server.use(siteverify({ success: true }));

      expect(await verify({ now: Date.parse(SOLVED_AT) + 300_000 })).toMatchObject({
        success: true,
      });
    });

    // Cloudflare always sends challenge_ts on success; its absence means freshness cannot
    // be established, which is a reason to reject rather than to skip the check.
    it.each([undefined, 'not-a-date'])('rejects challenge_ts %s', async (challengeTs) => {
      server.use(
        http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () =>
          HttpResponse.json({ success: true, challenge_ts: challengeTs }),
        ),
      );

      expect(await verify()).toMatchObject({ errorCodes: ['mita.invalid_challenge_ts'] });
    });

    it('skips the age check when the maximum age is infinite', async () => {
      server.use(http.post(TURNSTILE_SITEVERIFY_ENDPOINT, () => HttpResponse.json({ success: true })));

      expect(await verify({ maxAgeSeconds: Number.POSITIVE_INFINITY })).toMatchObject({
        success: true,
      });
    });
  });

  it('honours a custom endpoint and fetch implementation', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ success: true, challenge_ts: SOLVED_AT }),
    );

    const result = await verify({ endpoint: 'https://proxy.test/verify', fetch: fetchImpl });

    expect(result).toMatchObject({ success: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://proxy.test/verify');
  });
});
