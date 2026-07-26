import { generateDPoPKeyPair, signDPoP } from '@mita-auth/core';
import { createSecurityGuard } from '@mita-auth/server';
// The entry point Upstash documents for Workers. A bare `@upstash/redis` import resolves to
// the Node build, because that package's exports carry no `workerd` condition.
import { Redis } from '@upstash/redis/cloudflare';

interface Env {
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  TURNSTILE_SECRET_KEY: string;
}

/** One decidable claim per entry, reported together with the evidence behind it. */
type Probe = { name: string; ok: boolean; detail: string };

async function probePrimitives(): Promise<Probe[]> {
  const probes: Probe[] = [];

  probes.push({
    name: 'webcrypto',
    ok: typeof globalThis.crypto?.subtle?.digest === 'function',
    detail: `crypto.subtle=${typeof globalThis.crypto?.subtle}`,
  });

  // @upstash/ratelimit hashes its scripts with SHA-1, so that one digest needs confirming
  // on its own.
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('x'));
    probes.push({ name: 'webcrypto-sha1', ok: true, detail: `${digest.byteLength} bytes` });
  } catch (cause) {
    probes.push({ name: 'webcrypto-sha1', ok: false, detail: String(cause) });
  }

  probes.push({
    name: 'AbortSignal.timeout-exists',
    ok: typeof AbortSignal.timeout === 'function',
    detail: typeof AbortSignal.timeout,
  });

  // Existing is not aborting. `turnstile.ts` leans on it to bound siteverify at 5 seconds.
  try {
    const signal = AbortSignal.timeout(50);
    await fetch('https://cloudflare.com/cdn-cgi/trace', { signal });
    probes.push({ name: 'AbortSignal.timeout-aborts', ok: false, detail: 'request completed' });
  } catch (cause) {
    const aborted = cause instanceof Error && /abort|timeout/i.test(cause.name + cause.message);
    probes.push({ name: 'AbortSignal.timeout-aborts', ok: aborted, detail: String(cause) });
  }

  // The exact pair `replay.ts`'s `withTimeout` is built from.
  const timerFired = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), 10);
    setTimeout(() => {
      clearTimeout(timer);
      resolve(false);
    }, 500);
  });
  probes.push({ name: 'setTimeout-fires', ok: timerFired, detail: String(timerFired) });

  // Cloudflare documents `Date.now()` as the time of the last I/O. Report what it actually
  // does instead of assuming.
  const before = Date.now();
  let spin = 0;
  for (let i = 0; i < 5_000_000; i += 1) spin += i;
  const afterSync = Date.now();
  await fetch('https://cloudflare.com/cdn-cgi/trace');
  const afterIo = Date.now();
  probes.push({
    name: 'Date.now-frozen-during-sync',
    // Observation only — neither outcome is a failure.
    ok: true,
    detail: `sync delta=${afterSync - before}ms, io delta=${afterIo - afterSync}ms (spin=${spin > 0})`,
  });

  // core's whole DPoP issue-and-sign chain.
  try {
    const keyPair = await generateDPoPKeyPair();
    const proof = await signDPoP(keyPair, { method: 'POST', url: 'https://probe.test/x' });
    probes.push({ name: 'jose-es256-sign', ok: proof.split('.').length === 3, detail: 'compact JWS' });
  } catch (cause) {
    probes.push({ name: 'jose-es256-sign', ok: false, detail: String(cause) });
  }

  return probes;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/primitives') {
      return Response.json({ probes: await probePrimitives() });
    }

    // A real guard against real Upstash. The `/cloudflare` client is deliberate: the guard
    // does not identify it with `instanceof`, and that claim has to hold once more under
    // the actual runtime.
    const guard = createSecurityGuard({
      redis: new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      }),
      rateLimit: { requests: 5, window: '1 m', identifier: () => 'edge-probe' },
      turnstile: { secretKey: env.TURNSTILE_SECRET_KEY },
      dpop: true,
    });

    const check = await guard.verify(request);

    // Both outcomes owe background work. This line is the load-bearing assertion of Phase 5.
    ctx.waitUntil(check.pending);

    if (!check.success) {
      return check.response;
    }

    return Response.json(
      { ok: true, identifier: check.identifier, hadProof: check.proof !== undefined },
      { headers: check.headers },
    );
  },
};
