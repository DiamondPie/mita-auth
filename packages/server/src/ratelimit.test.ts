import { Redis } from '@upstash/redis';
import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  UNIDENTIFIED_RATE_LIMIT_KEY,
  createRateLimiter,
  resolveClientIp,
  type CreateRateLimiterOptions,
} from './ratelimit';

const REDIS_URL = 'https://ratelimit.upstash.test';
const PIPELINE_ENDPOINT = `${REDIS_URL}/pipeline`;

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

/** The sliding-window script answers `[remaining, limit]`, with -1 meaning "rejected". */
function scriptResult(remaining: number, limit = 10) {
  return http.post(PIPELINE_ENDPOINT, () => HttpResponse.json([{ result: [remaining, limit] }]));
}

function limiter(options: Partial<CreateRateLimiterOptions> = {}) {
  return createRateLimiter({
    // Retries would otherwise stack exponential backoff on top of every failure test.
    redis: new Redis({ url: REDIS_URL, token: 'test-token', retry: false }),
    ...options,
  });
}

function request(headers: Record<string, string> = {}) {
  return new Request('https://api.test/comments', { method: 'POST', headers });
}

describe('resolveClientIp', () => {
  it.each([
    ['cf-connecting-ip', '198.51.100.1'],
    ['x-real-ip', '198.51.100.2'],
    ['x-forwarded-for', '198.51.100.3'],
  ])('reads %s', (header, ip) => {
    expect(resolveClientIp(request({ [header]: ip }))).toBe(ip);
  });

  it('prefers cf-connecting-ip over the other headers', () => {
    const headers = {
      'cf-connecting-ip': '198.51.100.1',
      'x-real-ip': '198.51.100.2',
      'x-forwarded-for': '198.51.100.3',
    };

    expect(resolveClientIp(request(headers))).toBe('198.51.100.1');
  });

  it('prefers x-real-ip over x-forwarded-for', () => {
    const headers = { 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.3' };

    expect(resolveClientIp(request(headers))).toBe('198.51.100.2');
  });

  it('takes the left-most entry of a forwarding chain', () => {
    const headers = { 'x-forwarded-for': ' 198.51.100.3 , 10.0.0.1 , 10.0.0.2 ' };

    expect(resolveClientIp(request(headers))).toBe('198.51.100.3');
  });

  it('falls through a header that is present but empty', () => {
    const headers = { 'cf-connecting-ip': '  ', 'x-real-ip': '198.51.100.2' };

    expect(resolveClientIp(request(headers))).toBe('198.51.100.2');
  });

  it('returns null when no proxy header is present', () => {
    expect(resolveClientIp(request())).toBeNull();
  });

  describe('with a named header', () => {
    it('reads that one and ignores the rest of the list', () => {
      const headers = {
        'cf-connecting-ip': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
        'x-forwarded-for': '198.51.100.3',
      };

      expect(resolveClientIp(request(headers), 'x-real-ip')).toBe('198.51.100.2');
    });

    // Naming a header says a proxy overwrites it, and a comma in a value like that is part
    // of the value rather than a forwarding chain.
    it('takes the value whole rather than splitting a chain out of it', () => {
      const headers = { 'x-forwarded-for': '198.51.100.3, 10.0.0.1' };

      expect(resolveClientIp(request(headers), 'x-forwarded-for')).toBe('198.51.100.3, 10.0.0.1');
    });

    // Falling back would hide a misconfigured proxy behind a header the visitor can set.
    it('returns null rather than falling back to the list', () => {
      const headers = { 'cf-connecting-ip': '198.51.100.1' };

      expect(resolveClientIp(request(headers), 'x-real-ip')).toBeNull();
    });

    it('treats a header present but empty as absent', () => {
      expect(resolveClientIp(request({ 'x-real-ip': '  ' }), 'x-real-ip')).toBeNull();
    });
  });
});

describe('createRateLimiter', () => {
  it('allows a request inside the window', async () => {
    server.use(scriptResult(9));

    const decision = await limiter().limit(request({ 'cf-connecting-ip': '198.51.100.1' }));

    expect(decision).toMatchObject({
      success: true,
      identifier: '198.51.100.1',
      limit: 10,
      remaining: 9,
      degraded: false,
    });
  });

  it('rejects a request past the window', async () => {
    server.use(scriptResult(-1));

    const decision = await limiter().limit(request({ 'cf-connecting-ip': '198.51.100.1' }));

    expect(decision).toMatchObject({ success: false, degraded: false, remaining: 0 });
  });

  it('exposes the pending promise Edge runtimes must await', async () => {
    server.use(scriptResult(9));

    const decision = await limiter().limit(request({ 'x-real-ip': '198.51.100.2' }));

    await expect(decision.pending).resolves.not.toThrow();
  });

  it('buckets unidentifiable requests together', async () => {
    server.use(scriptResult(9));

    const decision = await limiter().limit(request());

    expect(decision.identifier).toBe(UNIDENTIFIED_RATE_LIMIT_KEY);
  });

  it('buckets by the named header instead of guessing', async () => {
    server.use(scriptResult(9));

    const decision = await limiter({ clientIpHeader: 'x-real-ip' }).limit(
      request({ 'cf-connecting-ip': '198.51.100.1', 'x-real-ip': '198.51.100.2' }),
    );

    expect(decision.identifier).toBe('198.51.100.2');
  });

  // `identifier` replaces the resolver outright, so there is nothing left for the header to
  // configure.
  it('lets a custom identifier win over the named header', async () => {
    server.use(scriptResult(9));

    const decision = await limiter({
      clientIpHeader: 'x-real-ip',
      identifier: () => 'tenant-7',
    }).limit(request({ 'x-real-ip': '198.51.100.2' }));

    expect(decision.identifier).toBe('tenant-7');
  });

  it('honours a custom identifier', async () => {
    server.use(scriptResult(9));

    const decision = await limiter({ identifier: () => 'tenant-7' }).limit(request());

    expect(decision.identifier).toBe('tenant-7');
  });

  it.each([
    ['null', () => null],
    ['undefined', () => undefined],
    // Left to `??` this became a key ending in a colon: a shared bucket by accident.
    ['an empty string', () => ''],
  ])('falls back to the shared bucket when the custom identifier yields %s', async (
    _name,
    identifier,
  ) => {
    server.use(scriptResult(9));

    const decision = await limiter({ identifier }).limit(request());

    expect(decision.identifier).toBe(UNIDENTIFIED_RATE_LIMIT_KEY);
  });

  it('passes the optional Upstash settings through', async () => {
    const sent: string[] = [];
    server.use(
      http.post(PIPELINE_ENDPOINT, async ({ request }) => {
        sent.push(await request.text());
        return HttpResponse.json([{ result: [9, 10] }]);
      }),
    );

    await limiter({
      prefix: 'acme',
      analytics: false,
      ephemeralCache: new Map(),
    }).limit(request({ 'cf-connecting-ip': '198.51.100.1' }));

    expect(sent[0]).toContain('acme:198.51.100.1');
  });

  describe('degradation', () => {
    it('fails open by default when Redis errors', async () => {
      server.use(
        http.post(PIPELINE_ENDPOINT, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      );

      const decision = await limiter().limit(request());

      expect(decision).toMatchObject({ success: true, degraded: true });
    });

    it('fails closed when configured to', async () => {
      server.use(
        http.post(PIPELINE_ENDPOINT, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      );

      const decision = await limiter({ failureMode: 'closed' }).limit(request());

      expect(decision).toMatchObject({ success: false, degraded: true });
    });

    it('reports the underlying error through onDegraded', async () => {
      server.use(
        http.post(PIPELINE_ENDPOINT, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      );
      const onDegraded = vi.fn();

      await limiter({ onDegraded }).limit(request());

      expect(onDegraded).toHaveBeenCalledWith('error', expect.anything());
    });

    it('degrades on a network error', async () => {
      server.use(http.post(PIPELINE_ENDPOINT, () => HttpResponse.error()));
      const onDegraded = vi.fn();

      const decision = await limiter({ onDegraded }).limit(request());

      expect(decision).toMatchObject({ success: true, degraded: true });
      expect(onDegraded).toHaveBeenCalledWith('error', expect.anything());
    });

    // Upstash's own timeout reports success, which would silently override failureMode.
    it('re-decides the Upstash timeout instead of inheriting its fail-open', async () => {
      server.use(
        http.post(PIPELINE_ENDPOINT, async () => {
          await delay(300);
          return HttpResponse.json([{ result: [9, 10] }]);
        }),
      );
      const onDegraded = vi.fn();

      const decision = await limiter({
        timeoutMs: 20,
        failureMode: 'closed',
        onDegraded,
      }).limit(request());

      expect(decision).toMatchObject({ success: false, degraded: true });
      expect(onDegraded).toHaveBeenCalledWith('timeout', undefined);
    });

    it('lets a timeout through when failing open', async () => {
      server.use(
        http.post(PIPELINE_ENDPOINT, async () => {
          await delay(300);
          return HttpResponse.json([{ result: [9, 10] }]);
        }),
      );

      const decision = await limiter({ timeoutMs: 20 }).limit(request());

      expect(decision).toMatchObject({ success: true, degraded: true });
    });
  });
});
