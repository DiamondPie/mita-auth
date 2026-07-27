import { isWellFormedTurnstileToken } from './validate';

export const TURNSTILE_SITEVERIFY_ENDPOINT =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const DEFAULT_TURNSTILE_TIMEOUT_MS = 5000;

/** Cloudflare expires a token 300 seconds after the challenge is solved. */
export const TURNSTILE_TOKEN_MAX_AGE_SECONDS = 300;

/** Codes Cloudflare's siteverify may return in `error-codes`. */
export const TURNSTILE_ERROR_CODES = [
  'missing-input-secret',
  'invalid-input-secret',
  'missing-input-response',
  'invalid-input-response',
  'bad-request',
  'timeout-or-duplicate',
  'internal-error',
] as const;

/**
 * Checks Mita performs locally, namespaced so they can never collide with a code
 * Cloudflare introduces later.
 */
export const MITA_TURNSTILE_ERROR_CODES = [
  'mita.hostname_mismatch',
  'mita.action_mismatch',
  'mita.invalid_challenge_ts',
  'mita.expired',
  'mita.http_error',
  'mita.malformed_response',
  'mita.network_error',
  'mita.runtime_unsupported',
] as const;

export type KnownTurnstileErrorCode =
  | (typeof TURNSTILE_ERROR_CODES)[number]
  | (typeof MITA_TURNSTILE_ERROR_CODES)[number];

/** Left open: Cloudflare can introduce codes this version does not know about. */
export type TurnstileErrorCode = KnownTurnstileErrorCode | (string & Record<never, never>);

/** The parts of a siteverify response worth surfacing to callers. */
export interface TurnstileChallenge {
  readonly hostname?: string;
  readonly action?: string;
  readonly cdata?: string;
  readonly challengeTs?: string;
  /** Enterprise-only device fingerprint. */
  readonly ephemeralId?: string;
}

/**
 * `rejected` means Cloudflare or a local check refused the token — the visitor failed.
 * `unavailable` means the verdict is unknown because siteverify could not be reached or
 * answered nonsense. The two carry different fail policies, so they stay distinct rather
 * than collapsing into one falsy result.
 */
export type TurnstileVerification =
  | { readonly success: true; readonly challenge: TurnstileChallenge }
  | {
      readonly success: false;
      readonly reason: 'rejected';
      readonly errorCodes: readonly TurnstileErrorCode[];
      readonly challenge: TurnstileChallenge;
    }
  | {
      readonly success: false;
      readonly reason: 'unavailable';
      readonly errorCodes: readonly TurnstileErrorCode[];
      readonly cause?: unknown;
    };

/**
 * The outcome that says nothing about the visitor.
 *
 * Worth a name of its own because it is the one a deployment has to be told about: the 503
 * it turns into carries no code and no cause, and a fail-closed Turnstile makes it the
 * difference between "one visitor failed" and "every write is down".
 */
export type TurnstileUnavailable = Extract<TurnstileVerification, { reason: 'unavailable' }>;

export interface VerifyTurnstileTokenOptions {
  /** Widget secret key. Never leaves this function. */
  secretKey: string;
  /** Token produced by the client-side widget. */
  token: string;
  /** Visitor IP, forwarded to Cloudflare as `remoteip`. */
  remoteIp?: string;
  /** UUID that makes a retried verification safe against `timeout-or-duplicate`. */
  idempotencyKey?: string;
  /** Hostnames the challenge may have been served from. Omit to skip the check. */
  allowedHostnames?: readonly string[];
  /** Action the widget must have declared. Omit to skip the check. */
  expectedAction?: string;
  /**
   * How old a solved challenge may be, in seconds. Defaults to Cloudflare's own 300.
   * Pass `Number.POSITIVE_INFINITY` to skip the check.
   */
  maxAgeSeconds?: number;
  /** Abort budget for the siteverify call. Defaults to 5000 ms. */
  timeoutMs?: number;
  endpoint?: string;
  /** Overrides the global `fetch`, for tests or runtimes with a custom implementation. */
  fetch?: typeof globalThis.fetch;
  /** Current time in epoch milliseconds. Injected by tests. */
  now?: number;
}

interface SiteverifyResponse {
  success?: unknown;
  'error-codes'?: unknown;
  challenge_ts?: unknown;
  hostname?: unknown;
  action?: unknown;
  cdata?: unknown;
  metadata?: unknown;
}

/** Cloudflare documents `internal-error` as retryable, so it is our problem, not the visitor's. */
const UNAVAILABLE_ERROR_CODES = new Set(['internal-error']);

/**
 * Verifies a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * A malformed token is rejected without spending a network round trip. Beyond
 * Cloudflare's own verdict this also enforces the checks Cloudflare recommends but does
 * not perform: hostname, action and challenge age.
 */
export async function verifyTurnstileToken(
  options: VerifyTurnstileTokenOptions,
): Promise<TurnstileVerification> {
  const {
    secretKey,
    token,
    remoteIp,
    idempotencyKey,
    allowedHostnames,
    expectedAction,
    maxAgeSeconds = TURNSTILE_TOKEN_MAX_AGE_SECONDS,
    timeoutMs = DEFAULT_TURNSTILE_TIMEOUT_MS,
    endpoint = TURNSTILE_SITEVERIFY_ENDPOINT,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now(),
  } = options;

  if (!isWellFormedTurnstileToken(token)) {
    return {
      success: false,
      reason: 'rejected',
      errorCodes: ['invalid-input-response'],
      challenge: {},
    };
  }

  // Built before the try, not inside it. As an argument it would be evaluated within the
  // same block, so a runtime without `AbortSignal.timeout` would be reported as a network
  // error — sending whoever has to diagnose it to Cloudflare's status page instead.
  let signal: AbortSignal;

  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch (cause) {
    return {
      success: false,
      reason: 'unavailable',
      errorCodes: ['mita.runtime_unsupported'],
      cause,
    };
  }

  let response: Response;

  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: toRequestBody({ secretKey, token, remoteIp, idempotencyKey }),
      signal,
    });
  } catch (cause) {
    return { success: false, reason: 'unavailable', errorCodes: ['mita.network_error'], cause };
  }

  if (!response.ok) {
    return { success: false, reason: 'unavailable', errorCodes: ['mita.http_error'] };
  }

  let payload: SiteverifyResponse;

  try {
    payload = (await response.json()) as SiteverifyResponse;
  } catch (cause) {
    return { success: false, reason: 'unavailable', errorCodes: ['mita.malformed_response'], cause };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { success: false, reason: 'unavailable', errorCodes: ['mita.malformed_response'] };
  }

  const challenge = toChallenge(payload);

  if (payload.success !== true) {
    const errorCodes = readErrorCodes(payload);

    return errorCodes.some((code) => UNAVAILABLE_ERROR_CODES.has(code))
      ? { success: false, reason: 'unavailable', errorCodes }
      : { success: false, reason: 'rejected', errorCodes, challenge };
  }

  const localFailure = runLocalChecks(challenge, {
    allowedHostnames,
    expectedAction,
    maxAgeSeconds,
    now,
  });

  if (localFailure !== null) {
    return { success: false, reason: 'rejected', errorCodes: [localFailure], challenge };
  }

  return { success: true, challenge };
}

function toRequestBody(input: {
  secretKey: string;
  token: string;
  remoteIp?: string;
  idempotencyKey?: string;
}): URLSearchParams {
  const body = new URLSearchParams({ secret: input.secretKey, response: input.token });

  if (input.remoteIp !== undefined) {
    body.set('remoteip', input.remoteIp);
  }

  if (input.idempotencyKey !== undefined) {
    body.set('idempotency_key', input.idempotencyKey);
  }

  return body;
}

function toChallenge(payload: SiteverifyResponse): TurnstileChallenge {
  const metadata = payload.metadata;
  const ephemeralId =
    typeof metadata === 'object' && metadata !== null
      ? readString((metadata as Record<string, unknown>).ephemeral_id)
      : undefined;

  return {
    hostname: readString(payload.hostname),
    action: readString(payload.action),
    cdata: readString(payload.cdata),
    challengeTs: readString(payload.challenge_ts),
    ephemeralId,
  };
}

function runLocalChecks(
  challenge: TurnstileChallenge,
  options: {
    allowedHostnames?: readonly string[];
    expectedAction?: string;
    maxAgeSeconds: number;
    now: number;
  },
): TurnstileErrorCode | null {
  const { allowedHostnames, expectedAction, maxAgeSeconds, now } = options;

  if (allowedHostnames !== undefined) {
    if (challenge.hostname === undefined || !allowedHostnames.includes(challenge.hostname)) {
      return 'mita.hostname_mismatch';
    }
  }

  if (expectedAction !== undefined && challenge.action !== expectedAction) {
    return 'mita.action_mismatch';
  }

  if (!Number.isFinite(maxAgeSeconds)) {
    return null;
  }

  // Cloudflare always sends challenge_ts on success, so an absent or unparseable value
  // means we cannot establish freshness — reject rather than silently skip the check.
  const solvedAt = challenge.challengeTs === undefined ? NaN : Date.parse(challenge.challengeTs);

  if (Number.isNaN(solvedAt)) {
    return 'mita.invalid_challenge_ts';
  }

  return now - solvedAt > maxAgeSeconds * 1000 ? 'mita.expired' : null;
}

function readErrorCodes(payload: SiteverifyResponse): readonly TurnstileErrorCode[] {
  const codes = payload['error-codes'];

  if (!Array.isArray(codes)) {
    return [];
  }

  return codes.filter((code): code is string => typeof code === 'string');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
