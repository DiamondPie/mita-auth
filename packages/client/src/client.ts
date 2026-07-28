import {
  DPOP_AUTH_SCHEME,
  MITA_HEADERS,
  MitaError,
  generateDPoPKeyPair,
  signDPoP,
  type DPoPAlgorithm,
  type DPoPKeyPair,
} from '@mita-auth/core';
import ky, { type KyInstance, type Options } from 'ky';

import { consumeTurnstileToken, markSessionActive, markSessionUnauthorized } from './state';

/** How many times one request may redo the RFC 9449 nonce handshake before giving up. */
export const DEFAULT_NONCE_RETRY_LIMIT = 1;

/** ky's own default, which stands whenever the caller passes no `retry` option. */
const DEFAULT_KY_RETRY_LIMIT = 2;

/** ky's own default, which stands whenever the caller passes no `timeout` option. */
const DEFAULT_KY_TIMEOUT = 10_000;

/**
 * Why a request was not authorized.
 *
 * `nonce_exhausted` means the handshake budget ran out before the server stopped asking for
 * a new nonce; it says nothing about this browser's key pair, which is why it leaves the
 * session status alone. `unauthorized` covers a 401 that carried no DPoP challenge this
 * client understands.
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
 * Every attempt carries a freshly signed DPoP proof. The server issues a `DPoP-Nonce` with
 * each answer and accepts each one exactly once, so the proof has to be re-signed for every
 * attempt — including retries that failed for unrelated reasons, since a `jti` is equally
 * single-use.
 *
 * A client with no nonce yet cannot avoid being turned away once: RFC 9449 defines that
 * first `use_dpop_nonce` rejection as the handshake. It is resolved here rather than
 * surfaced to the caller.
 *
 * The whole protocol rides on this instance's hooks — signing and queueing are installed by
 * the `init` hook below, the Turnstile header by `beforeRequest`, the handshake by
 * `afterResponse`. ky appends hooks when a call or an `extend()` supplies its own, so adding
 * to them is safe; *replacing* them is not. `hooks: replaceOption({ ... })` and
 * `hooks: { init: undefined }` both drop this package's hooks, and what is left is plain ky:
 * requests go out unsigned, unqueued and without a token, and the only symptom is the
 * server refusing them. Add hooks, never replace them.
 */
export function createProtectedClient(options: CreateProtectedClientOptions = {}): KyInstance {
  const {
    keyPair,
    algorithm,
    nonceRetryLimit = DEFAULT_NONCE_RETRY_LIMIT,
    turnstile = true,
    onUnauthorized,
    hooks,
    fetch: callerFetch,
    ...kyOptions
  } = options;

  if (!Number.isInteger(nonceRetryLimit) || nonceRetryLimit < 0) {
    throw new MitaError(
      'client.invalid_nonce_retry_limit',
      `The nonce retry limit must be a non-negative integer, received ${String(nonceRetryLimit)}.`,
    );
  }

  const retryLimit =
    typeof kyOptions.retry === 'number'
      ? kyOptions.retry
      : (kyOptions.retry?.limit ?? DEFAULT_KY_RETRY_LIMIT);

  // ky bounds the total number of attempts, handshakes included. A budget it cannot honour
  // would surface as a forced-retry error carrying no status code and no callback, which is
  // close to undiagnosable from the outside; refusing it here costs one line at startup.
  if (retryLimit < nonceRetryLimit) {
    throw new MitaError(
      'client.retry_limit_too_low',
      `A nonce retry limit of ${nonceRetryLimit} needs \`retry.limit\` to be at least as high, received ${retryLimit}. Set \`nonceRetryLimit: 0\` to opt out of the handshake as well.`,
    );
  }

  let pendingKeyPair: Promise<DPoPKeyPair> | undefined;
  let nonce: string | undefined;

  /** Tail of the chain every attempt queues behind. See {@link attempt}. */
  let queue: Promise<unknown> = Promise.resolve();

  /** Attempts queued or in flight, and how long the last completed round trip took. */
  let queueDepth = 0;
  let lastRtt: number | undefined;

  const leaveQueue = (): void => {
    queueDepth -= 1;
  };

  /**
   * Handshake budget for one call, kept apart from `retry.limit` so that a backoff spent
   * on a 429 does not also consume the client's only chance to fetch a nonce.
   * `retry.limit` still bounds the total number of attempts.
   */
  const handshakes = new WeakMap<object, { retries: number }>();

  const baseFetch: NonNullable<Options['fetch']> =
    callerFetch ?? ((input, init) => globalThis.fetch(input, init));

  function resolveKeyPair(): Promise<DPoPKeyPair> {
    pendingKeyPair ??= Promise.resolve(
      keyPair ?? generateDPoPKeyPair(algorithm === undefined ? {} : { algorithm }),
    );

    return pendingKeyPair;
  }

  /**
   * Signs an attempt, sends it, and absorbs the answer as one indivisible step.
   *
   * A nonce is spent by the first proof that echoes it, so two attempts signed over the same
   * one cannot both be accepted. Queueing the whole exchange — read the nonce, spend it,
   * take the replacement — is what keeps concurrent calls on one instance from racing for
   * it: each attempt signs over whatever the attempt before it brought back, and the burst
   * costs no more requests than it would have serially.
   *
   * The queue holds per attempt rather than per call, so a backoff between two attempts does
   * not block the other calls, and it advances from a single `then` that a network error, a
   * timeout or an abort all reach. A hook pair could not offer either: `afterResponse` never
   * runs when there is no response, and ky has no hook for "this call is over".
   *
   * Signing here also puts the proof after every caller hook has finished rewriting the
   * request, which is where it has to be — the proof binds the method and URL it is sent to.
   *
   * The one cost of queueing is that ky's timer is already running while an attempt waits, so
   * a burst deep enough to outlast `timeout` would have its tail rejected as timed out —
   * without a status code, without `onUnauthorized`, and without ever reaching the server.
   * Attempts that can be seen to be in that position up front are refused instead.
   *
   * `budget` and `send` are bound per call by the init hook rather than read from the
   * instance: both are options ky lets a single call override, and this runs on behalf of
   * whichever call reached the front.
   */
  const attempt = (
    request: Request,
    init: RequestInit | undefined,
    budget: number | undefined,
    send: NonNullable<Options['fetch']>,
  ): Promise<Response> => {
    // Only armed once a round trip has been observed; a lone request cannot queue behind
    // anything, so there is nothing to predict before the first one comes back.
    if (budget !== undefined && lastRtt !== undefined && (queueDepth + 1) * lastRtt > budget) {
      // Refused before joining the queue, so it does not deepen the saturation it reports.
      // Rejecting rather than throwing also lets ky clear the timer it armed for this attempt.
      return Promise.reject(
        new MitaError(
          'client.queue_saturated',
          `This client already has ${queueDepth} request(s) queued at about ${lastRtt} ms each, which leaves no room for another inside the ${budget} ms timeout. Requests on one instance are sent one at a time and share that budget, so raise \`timeout\`, send fewer at once, or split the burst across separate clients.`,
        ),
      );
    }

    const run = async (): Promise<Response> => {
      request.headers.set(
        MITA_HEADERS.dpop,
        await signDPoP(await resolveKeyPair(), {
          method: request.method,
          url: request.url,
          ...(nonce === undefined ? {} : { nonce }),
        }),
      );

      const sentAt = Date.now();
      const response = await send(request, init);

      lastRtt = Date.now() - sentAt;

      const issued = response.headers.get(MITA_HEADERS.dpopNonce);

      if (issued !== null) {
        nonce = issued;

        // Only a server that actually ran the DPoP path hands back a nonce, so this is the
        // point at which a proof is known to have been accepted.
        if (response.ok) {
          markSessionActive();
        }
      }

      return response;
    };

    queueDepth += 1;

    const settled = queue.then(run, run);

    // The queue tracks arrival, not outcome: a failed attempt must not wedge the ones behind
    // it, and its rejection is the caller's to handle rather than the chain's.
    queue = settled.then(leaveQueue, leaveQueue);

    return settled;
  };

  function reject(request: Request, response: Response, reason: UnauthorizedReason): void {
    // A spent handshake budget is not an authorization verdict. `state.ts` reserves
    // `unauthorized` for a rejection retrying cannot fix, and a nonce is not one of those:
    // the next request signs over the one this response just issued.
    if (reason !== 'nonce_exhausted') {
      markSessionUnauthorized();
    }

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

          // Binding `fetch` here rather than in the instance options is what lets a single
          // call's `timeout` and `fetch` be honoured: this hook runs after ky has merged
          // them and before it constructs anything from them. Reading `timeout` off the
          // instance instead would refuse bursts that a call raising its own budget had
          // every chance of finishing.
          //
          // ky charges each attempt against `min(timeout, what is left of totalTimeout)`, so
          // a prediction that reads only one of the two is wrong in both directions:
          // `timeout: false` on its own would switch the check off while ky still cuts the
          // call short at `totalTimeout`, and reading `timeout` while both are set would
          // over-estimate the room left. Weighing the whole call's budget against a single
          // attempt is conservative, and conservative the right way round — better to hold
          // one request back than to send one that cannot finish.
          const perAttempt =
            callOptions.timeout === false
              ? Number.POSITIVE_INFINITY
              : (callOptions.timeout ?? DEFAULT_KY_TIMEOUT);
          const total =
            callOptions.totalTimeout === undefined || callOptions.totalTimeout === false
              ? Number.POSITIVE_INFINITY
              : callOptions.totalTimeout;
          const ceiling = Math.min(perAttempt, total);
          const budget = Number.isFinite(ceiling) ? ceiling : undefined;
          const send = callOptions.fetch ?? baseFetch;

          // ky hands its `fetch` a `Request` on every attempt; the option's wider signature
          // is the Fetch API's, not ky's. Narrowing it keeps the signing path free of a
          // branch ky cannot take, and a drift would fail every request rather than hide.
          callOptions.fetch = (request, init) => attempt(request as Request, init, budget, send);
        },
      ],
      beforeRequest: [
        ...(hooks?.beforeRequest ?? []),
        ({ request }) => {
          // One call, one token. This runs before ky takes the clone it retries with, so a
          // handshake resends the same token — the server spends it only after the proof has
          // been accepted, and the widget has no second one to offer until the visitor
          // solves another challenge.
          if (turnstile && !request.headers.has(MITA_HEADERS.turnstile)) {
            const token = consumeTurnstileToken();

            if (token !== null) {
              request.headers.set(MITA_HEADERS.turnstile, token);
            }
          }
        },
      ],
      afterResponse: [
        ({ request, response, options: callOptions, retryCount }) => {
          if (response.ok || response.status !== 401) {
            return;
          }

          const error = readChallengeError(response.headers.get('www-authenticate'));

          if (error !== 'use_dpop_nonce') {
            reject(request, response, error === null ? 'unauthorized' : 'invalid_dpop_proof');
            return;
          }

          const state = handshakes.get(callOptions.context);
          const attemptsLeft = (callOptions.retry.limit ?? DEFAULT_KY_RETRY_LIMIT) - retryCount;

          // Forcing a retry ky will not run turns a 401 into an opaque forced-retry error,
          // taking the status code and `onUnauthorized` with it. Better to report the 401.
          if (state === undefined || state.retries >= nonceRetryLimit || attemptsLeft <= 0) {
            reject(request, response, 'nonce_exhausted');
            return;
          }

          state.retries += 1;

          // The nonce this response carried has already been absorbed, and the next attempt
          // signs over it. There is nothing to back off from — the server has just handed
          // over exactly what the retry needs — so the usual delay is skipped.
          return ky.retry({ code: 'use_dpop_nonce', delay: 0 });
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
