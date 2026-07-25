import { MitaError } from '../errors';

/**
 * Resolves WebCrypto from the global scope.
 *
 * `@mita/core` deliberately never imports `node:crypto`: the same build has to run on
 * Node.js 22+, browsers, Cloudflare Workers, Deno and Vercel Edge.
 */
export function getWebCrypto(): Crypto {
  const webcrypto = globalThis.crypto as Crypto | undefined;

  if (!webcrypto?.getRandomValues || !webcrypto.subtle) {
    throw new MitaError(
      'runtime.webcrypto_unavailable',
      'WebCrypto is unavailable. @mita/core requires a runtime exposing globalThis.crypto (Node.js >= 22, modern browsers, Workers, Deno).',
    );
  }

  return webcrypto;
}

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await getWebCrypto().subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}
