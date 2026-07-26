import type { Duration } from '@upstash/ratelimit';
import { describe, expect, it } from 'vitest';

import { createMemoryRateLimiter, createMemoryReplayStore } from './memory';
import { UNIDENTIFIED_RATE_LIMIT_KEY } from './ratelimit';

/** A clock the test moves by hand, so nothing here waits on a real TTL. */
function clock(start = 1_700_000_000_000) {
  let at = start;

  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://api.test/comments', { method: 'POST', headers });
}

describe('createMemoryReplayStore', () => {
  it('issues a nonce that redeems exactly once', async () => {
    const store = createMemoryReplayStore();
    const issued = await store.issueNonce();

    expect(issued.ok).toBe(true);

    const value = issued.ok ? issued.nonce.value : '';

    await expect(store.consumeNonce(value)).resolves.toEqual({ ok: true });
    await expect(store.consumeNonce(value)).resolves.toEqual({
      ok: false,
      reason: 'unknown_nonce',
    });
  });

  it('refuses a nonce it never issued', async () => {
    const store = createMemoryReplayStore();

    await expect(store.consumeNonce('bWl0YS1uZXZlci1pc3N1ZWQtbm9uY2UtdmFsdWUtcGFk')).resolves
      .toEqual({ ok: false, reason: 'unknown_nonce' });
  });

  // Rejected on shape before it is looked up, exactly as the Redis store does — an
  // oversized or non-base64url value is not worth a lookup.
  it('refuses a value that is not a nonce at all', async () => {
    const store = createMemoryReplayStore();

    await expect(store.consumeNonce('nope')).resolves.toEqual({
      ok: false,
      reason: 'unknown_nonce',
    });
  });

  it('forgets a nonce once its lifetime is up', async () => {
    const time = clock();
    const store = createMemoryReplayStore({ nonceTtlMs: 1000, now: time.now });
    const issued = await store.issueNonce();
    const value = issued.ok ? issued.nonce.value : '';

    time.advance(1001);

    await expect(store.consumeNonce(value)).resolves.toEqual({
      ok: false,
      reason: 'unknown_nonce',
    });
  });

  it('claims a proof identifier once and calls the second one a replay', async () => {
    const store = createMemoryReplayStore();
    const claim = { jti: 'jti-1', jkt: 'jkt-1' };

    await expect(store.rememberProof(claim)).resolves.toEqual({ ok: true });
    await expect(store.rememberProof(claim)).resolves.toEqual({ ok: false, reason: 'replayed' });
  });

  // Without the `jkt` scope, one client picking a `jti` would lock every other client out
  // of the same value.
  it('scopes a proof identifier to the key that signed it', async () => {
    const store = createMemoryReplayStore();

    await expect(store.rememberProof({ jti: 'shared', jkt: 'jkt-1' })).resolves.toEqual({
      ok: true,
    });
    await expect(store.rememberProof({ jti: 'shared', jkt: 'jkt-2' })).resolves.toEqual({
      ok: true,
    });
  });

  it('lets a proof identifier be claimed again once its window has passed', async () => {
    const time = clock();
    const store = createMemoryReplayStore({ now: time.now });
    const claim = { jti: 'jti-1', jkt: 'jkt-1', ttlMs: 500 };

    await store.rememberProof(claim);
    time.advance(501);

    await expect(store.rememberProof(claim)).resolves.toEqual({ ok: true });
  });

  // Nothing sweeps the map on a timer, so a write does it periodically. The point is that
  // the store keeps answering correctly across that boundary.
  it('stays correct across a sweep', async () => {
    const time = clock();
    const store = createMemoryReplayStore({ now: time.now });

    for (let index = 0; index < 300; index += 1) {
      await store.rememberProof({ jti: `jti-${index}`, jkt: 'jkt-1', ttlMs: 100 });
    }

    time.advance(101);

    await expect(store.rememberProof({ jti: 'jti-0', jkt: 'jkt-1' })).resolves.toEqual({ ok: true });
    await expect(store.rememberProof({ jti: 'jti-0', jkt: 'jkt-1' })).resolves.toEqual({
      ok: false,
      reason: 'replayed',
    });
  });
});

describe('createMemoryRateLimiter', () => {
  it('allows the configured number of requests and then stops', async () => {
    const limiter = createMemoryRateLimiter({ requests: 2, window: '1 m' });

    await expect(limiter.limit(request())).resolves.toMatchObject({ success: true, remaining: 1 });
    await expect(limiter.limit(request())).resolves.toMatchObject({ success: true, remaining: 0 });
    await expect(limiter.limit(request())).resolves.toMatchObject({ success: false, remaining: 0 });
  });

  it('answers without degrading or owing anything', async () => {
    const limiter = createMemoryRateLimiter();
    const decision = await limiter.limit(request());

    expect(decision.degraded).toBe(false);
    await expect(decision.pending).resolves.toBeUndefined();
  });

  it('buckets by client IP', async () => {
    const limiter = createMemoryRateLimiter({ requests: 1 });

    await expect(limiter.limit(request({ 'x-real-ip': '1.1.1.1' }))).resolves.toMatchObject({
      success: true,
      identifier: '1.1.1.1',
    });
    await expect(limiter.limit(request({ 'x-real-ip': '2.2.2.2' }))).resolves.toMatchObject({
      success: true,
    });
    await expect(limiter.limit(request({ 'x-real-ip': '1.1.1.1' }))).resolves.toMatchObject({
      success: false,
    });
  });

  it.each([
    ['null', () => null],
    ['undefined', () => undefined],
    ['an empty string', () => ''],
  ])('sends %s to the shared bucket', async (_name, identifier) => {
    const limiter = createMemoryRateLimiter({ identifier });

    await expect(limiter.limit(request())).resolves.toMatchObject({
      identifier: UNIDENTIFIED_RATE_LIMIT_KEY,
    });
  });

  // The whole point of a sliding window: a fixed one would let 2× the limit through by
  // spending it just before a boundary and again just after.
  it('carries the previous window in proportion to how much of this one is left', async () => {
    const time = clock(0);
    const limiter = createMemoryRateLimiter({ requests: 4, window: '10 s', now: time.now });

    for (let index = 0; index < 4; index += 1) {
      await limiter.limit(request());
    }

    // The instant the window turns over, all four still count against the caller.
    time.advance(10_000);
    await expect(limiter.limit(request())).resolves.toMatchObject({ success: false });

    // Halfway through the new one, half of them do.
    time.advance(5000);
    await expect(limiter.limit(request())).resolves.toMatchObject({ success: true, remaining: 1 });
  });

  it('reports when the current window ends', async () => {
    const time = clock(0);
    const limiter = createMemoryRateLimiter({ window: '10 s', now: time.now });

    time.advance(3000);

    await expect(limiter.limit(request())).resolves.toMatchObject({ reset: 10_000 });
  });

  it.each(['1 m', '1m', '500 ms', '2 h', '1 d'] as const)('accepts the window %j', (window) => {
    expect(() => createMemoryRateLimiter({ window })).not.toThrow();
  });

  it.each(['', 'soon', '0 s', '1 y'])('refuses the window %j', (window) => {
    expect(() => createMemoryRateLimiter({ window: window as Duration })).toThrow(
      /positive duration/,
    );
  });

  it('keeps counting correctly after pruning old windows', async () => {
    const time = clock(0);
    const limiter = createMemoryRateLimiter({ requests: 1, window: '1 s', now: time.now });

    for (let index = 0; index < 300; index += 1) {
      await limiter.limit(request({ 'x-real-ip': `10.0.0.${index % 255}` }));
      time.advance(1000);
    }

    await expect(limiter.limit(request({ 'x-real-ip': '10.0.0.1' }))).resolves.toMatchObject({
      success: true,
    });
  });
});
