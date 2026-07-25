import {
  DPOP_AUTH_SCHEME,
  MITA_HEADERS,
  MitaError,
  generateDPoPKeyPair,
  signDPoP,
  type DPoPAlgorithm,
  type DPoPKeyPair,
} from '@mita/core';
import ky, { type KyInstance, type Options } from 'ky';

import { consumeTurnstileToken, markSessionActive, markSessionUnauthorized } from './state';

/** How many times one request may redo the RFC 9449 nonce handshake before giving up. */
export const DEFAULT_NONCE_RETRY_LIMIT = 1;

/**
 * Why a request was not authorized.
 *
 * `nonce_exhausted` means the server kept asking for a new nonce past the retry budget,
 * which points at the server's nonce store rather than at this client. `unauthorized`
 * covers a 401 that carried no DPoP challenge this client understands.
 */
export type UnauthorizedReason = 'invalid_dpop_proof' | 'nonce_exhausted' | 'unauthorized';

export interface UnauthorizedContext {
  readonly request: Request;
  readonly response: Response;
  readonly reason: UnauthorizedReason;
}

export interface CreateProtectedClientOptions extends Options {
  /**
   * Key pair to sign proofs with. Defaults to a fresh non-extractable pair generated on
   * the first request and held only in memory, so a closed tab leaves nothing behind.
   */
  keyPair?: DPoPKeyPair | Promise<DPoPKeyPair>;
  /** Algorithm for the generated key pair. Ignored when {@link keyPair} is supplied. */
  algorithm?: DPoPAlgorithm;
  /** Defaults to {@link DEFAULT_NONCE_RETRY_LIMIT}. */
  nonceRetryLimit?: number;
  /** Send the token held in `$turnstileToken`. Defaults to true. */
  turnstile?: boolean;
  /** Called when a 401 cannot be resolved by retrying. */
  onUnauthorized?: (context: UnauthorizedContext) => void;
}

const DPOP_CHALLENGE_PATTERN = new RegExp(`^${DPOP_AUTH_SCHEME}(?:\\s|$)`, 'i');
const CHALLENGE_ERROR_PATTERN = /\berror="([^"]*)"/;

/**
 * Builds a `ky` instance that speaks Mita's wire protocol.
 *
 * Every request carries a freshly signed DPoP proof. The server issues a `DPoP-Nonce`
 * with each answer and accepts each one exactly once, so the proof has to be re-signed
 * for every attempt — including retries that failed for unrelated reasons, since a `jti`
 * is equally single-use.
 *
 * A client with no nonce yet cannot avoid being turned away once: RFC 9449 defines that
 * first `use_dpop_nonce` rejection as the handshake. It is resolved here rather than
 * surfaced to the caller.
 */
export function createProtectedClient(options: CreateProtectedClientOptions = {}): KyInstance {
  const {
    keyPair,
    algorithm,
    nonceRetryLimit = DEFAULT_NONCE_RETRY_LIMIT,
    turnstile = true,
    onUnauthorized,
    hooks,
    ...kyOptions
  } = options;

  if (!Number.isInteger(nonceRetryLimit) || nonceRetryLimit < 0) {
    throw new MitaError(
      'client.invalid_nonce_retry_limit',
      `The nonce retry limit must be a non-negative integer, received ${String(nonceRetryLimit)}.`,
    );
  }

  let pendingKeyPair: Promise<DPoPKeyPair> | undefined;
  let nonce: string | undefined;

  /**
   * Handshake budget for one call, kept apart from `retry.limit` so that a backoff spent
   * on a 429 does not also consume the client's only chance to fetch a nonce.
   * `retry.limit` still bounds the total number of attempts.
   */
  const handshakes = new WeakMap<object, { retries: number }>();

  function resolveKeyPair(): Promise<DPoPKeyPair> {
    pendingKeyPair ??= Promise.resolve(
      keyPair ?? generateDPoPKeyPair(algorithm === undefined ? {} : { algorithm }),
    );

    return pendingKeyPair;
  }

  async function protect(request: Request): Promise<void> {
    const pair = await resolveKeyPair();

    request.headers.set(
      MITA_HEADERS.dpop,
      await signDPoP(pair, {
        method: request.method,
        url: request.url,
        ...(nonce === undefined ? {} : { nonce }),
      }),
    );

    // A retry keeps the token it already carries. The server spends it only after the
    // proof has been accepted, and the widget has no second token to offer until the
    // visitor solves another challenge.
    if (turnstile && !request.headers.has(MITA_HEADERS.turnstile)) {
      const token = consumeTurnstileToken();

      if (token !== null) {
        request.headers.set(MITA_HEADERS.turnstile, token);
      }
    }
  }

  function reject(request: Request, response: Response, reason: UnauthorizedReason): void {
    markSessionUnauthorized();
    onUnauthorized?.({ request, response, reason });
  }

  return ky.create({
    ...kyOptions,
    hooks: {
      ...hooks,
      init: [
        ...(hooks?.init ?? []),
        (callOptions) => {
          // ky re-clones the request before every attempt, so it cannot anchor a counter
          // that has to outlive a retry. `context` is per-call and survives untouched —
          // but only gets copied per call when an init hook exists, which is this one.
          callOptions.context = { ...callOptions.context };
          handshakes.set(callOptions.context, { retries: 0 });
        },
      ],
      // Mita signs last so that the proof binds the request a user hook has finished
      // rewriting, rather than the one it was handed.
      beforeRequest: [
        ...(hooks?.beforeRequest ?? []),
        async ({ request }) => {
          await protect(request);
        },
      ],
      beforeRetry: [
        ...(hooks?.beforeRetry ?? []),
        async ({ request }) => {
          await protect(request);
        },
      ],
      // Mita reads first, so the nonce is taken off the server's own response before a
      // user hook can replace it.
      afterResponse: [
        ({ request, response, options: callOptions }) => {
          const issued = response.headers.get(MITA_HEADERS.dpopNonce);

          if (issued !== null) {
            nonce = issued;
          }

          if (response.ok) {
            // Only a server that actually ran the DPoP path hands back a nonce, so this
            // is the point at which a proof is known to have been accepted.
            if (issued !== null) {
              markSessionActive();
            }

            return;
          }

          if (response.status !== 401) {
            return;
          }

          const error = readChallengeError(response.headers.get('www-authenticate'));

          if (error !== 'use_dpop_nonce') {
            reject(request, response, error === null ? 'unauthorized' : 'invalid_dpop_proof');
            return;
          }

          const state = handshakes.get(callOptions.context);

          if (state === undefined || state.retries >= nonceRetryLimit) {
            reject(request, response, 'nonce_exhausted');
            return;
          }

          state.retries += 1;

          // The nonce just absorbed is only usable by a proof signed over it, which is
          // what `beforeRetry` produces.
          return ky.retry({ code: 'use_dpop_nonce' });
        },
        ...(hooks?.afterResponse ?? []),
      ],
    },
  });
}

/** Reads the `error` parameter out of a `WWW-Authenticate: DPoP ...` challenge. */
function readChallengeError(header: string | null): string | null {
  if (header === null || !DPOP_CHALLENGE_PATTERN.test(header)) {
    return null;
  }

  return CHALLENGE_ERROR_PATTERN.exec(header)?.[1] ?? null;
}
