/**
 * Cloudflare's published Turnstile test keys.
 *
 * They are accepted on any domain, localhost included, so the four acceptance scenarios
 * reproduce on a machine that has no Cloudflare account. Source:
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export const TURNSTILE_SITE_KEYS = {
  /** Solves itself as soon as the widget renders. */
  autoPass: '1x00000000000000000000AA',
  /** Waits for a click, which is the only way to submit while no token exists yet. */
  interactive: '3x00000000000000000000FF',
} as const;

export type TurnstileMode = keyof typeof TURNSTILE_SITE_KEYS;

/** Accepts every token the test sitekeys mint. */
export const TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';

/** Deliberately small, so the limit is reachable by hand in a few seconds. */
export const RATE_LIMIT = { requests: 5, window: '1 m' } as const;
