import { isHTTPError } from 'ky';

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

export async function describeFailure(cause: unknown): Promise<string> {
  if (!isHTTPError(cause)) {
    return 'The request never reached the server.';
  }

  const body: unknown = await cause.response.json().catch(() => null);
  const reason =
    typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : null;
  const known = reason === null ? undefined : MESSAGES[reason];

  return known ?? `Request failed with ${cause.response.status}${reason === null ? '' : ` (${reason})`}.`;
}
