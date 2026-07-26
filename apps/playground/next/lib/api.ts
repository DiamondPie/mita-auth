import { createProtectedClient, type KyInstance } from '@mita-auth/client';

let client: KyInstance | undefined;

/**
 * The protected client, built on first use rather than at import time.
 *
 * It generates a non-extractable key pair that lives only in this tab's memory, and both
 * frameworks execute a component's module during server rendering. Reaching for it from an
 * event handler is what keeps the pair a browser-only thing.
 *
 * Nothing below this line speaks the protocol: the DPoP proof, the nonce handshake and the
 * Turnstile header are all the client's own doing.
 */
export function getApi(): KyInstance {
  client ??= createProtectedClient({
    onUnauthorized: ({ reason }) => {
      console.warn(`[mita] the session could not be recovered: ${reason}`);
    },
  });

  return client;
}
