import { isHTTPError } from '@mita-auth/client';

/** The guard's own rejection reasons, plus this app's one validation failure. */
const MESSAGES: Record<string, string> = {
  rate_limited: 'Too many comments too quickly — the rate limiter turned this one away.',
  rate_limit_unavailable: 'The rate limiter could not be reached.',
  turnstile_missing: 'Solve the Turnstile challenge before submitting.',
  turnstile_rejected: 'Cloudflare refused that Turnstile token.',
  turnstile_unavailable: 'Cloudflare could not be reached, so the challenge went unverified.',
  dpop_missing: 'The request carried no DPoP proof.',
  dpop_invalid: 'The DPoP proof was rejected.',
  dpop_nonce_required: 'The server asked for a fresh nonce more often than the client will retry.',
  dpop_replayed: 'That DPoP proof had already been spent.',
  store_unavailable: 'The replay store could not be reached.',
  invalid_comment: 'The server rejected the comment as invalid.',
};

export function describeFailure(cause: unknown): string {
  if (!isHTTPError(cause)) {
    return 'The request never reached the server.';
  }

  // `error.data`, not `error.response.json()`: ky pre-parses the body into `data` and that
  // consumes the response, so reading the response instead quietly falls through to the
  // generic message for every rejection the guard took the trouble to name.
  const body: unknown = cause.data;
  const reason =
    typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : null;
  const known = reason === null ? undefined : MESSAGES[reason];

  return known ?? `Request failed with ${cause.response.status}${reason === null ? '' : ` (${reason})`}.`;
}
