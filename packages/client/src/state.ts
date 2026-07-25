import { atom, batch, computed, readonlyType, type ReadableAtom } from 'nanostores';

/**
 * How far this browser has got with the server's DPoP exchange.
 *
 * Mita has no login step. A session turns `active` the moment the server accepts a proof
 * signed by this browser's key pair, and `unauthorized` when it rejects one for a reason
 * retrying cannot fix — a spent nonce is not that reason, since the client resolves it on
 * its own.
 */
export type SessionStatus = 'idle' | 'active' | 'unauthorized';

/**
 * Lifecycle of the Turnstile widget's token.
 *
 * `spent` and `expired` both leave the widget needing a reset before another token exists.
 * They stay distinct so the UI can tell a normal submission apart from a challenge the
 * visitor left sitting too long.
 */
export type TurnstileStatus = 'idle' | 'pending' | 'solved' | 'spent' | 'expired' | 'error';

const $writableSessionStatus = atom<SessionStatus>('idle');
const $writableTurnstileStatus = atom<TurnstileStatus>('idle');
const $writableTurnstileToken = atom<string | null>(null);

export const $sessionStatus: ReadableAtom<SessionStatus> = readonlyType($writableSessionStatus);

/** Whether the server has accepted a proof from this browser's key pair. */
export const $isAuthenticated: ReadableAtom<boolean> = computed(
  $writableSessionStatus,
  (status) => status === 'active',
);

export const $turnstileStatus: ReadableAtom<TurnstileStatus> =
  readonlyType($writableTurnstileStatus);

/**
 * The unspent Turnstile token, or `null` when there is nothing to send.
 *
 * Exposed read-only because the token and {@link $turnstileStatus} describe one fact
 * between them; writing either alone would let them disagree.
 */
export const $turnstileToken: ReadableAtom<string | null> = readonlyType($writableTurnstileToken);

export function markSessionActive(): void {
  $writableSessionStatus.set('active');
}

export function markSessionUnauthorized(): void {
  $writableSessionStatus.set('unauthorized');
}

/** Announces that a widget is on screen and waiting on the visitor. */
export function markTurnstilePending(): void {
  batch(() => {
    $writableTurnstileStatus.set('pending');
    $writableTurnstileToken.set(null);
  });
}

export function setTurnstileToken(token: string): void {
  batch(() => {
    $writableTurnstileStatus.set('solved');
    $writableTurnstileToken.set(token);
  });
}

/**
 * Hands the token to a request and marks it spent.
 *
 * Cloudflare's `siteverify` accepts a token exactly once, so a token that has been sent
 * must never be sent again — the widget has to produce a fresh one, which it does by
 * watching for this transition.
 */
export function consumeTurnstileToken(): string | null {
  const token = $writableTurnstileToken.get();

  if (token === null) {
    return null;
  }

  batch(() => {
    $writableTurnstileStatus.set('spent');
    $writableTurnstileToken.set(null);
  });

  return token;
}

export function expireTurnstileToken(): void {
  batch(() => {
    $writableTurnstileStatus.set('expired');
    $writableTurnstileToken.set(null);
  });
}

export function markTurnstileError(): void {
  batch(() => {
    $writableTurnstileStatus.set('error');
    $writableTurnstileToken.set(null);
  });
}

/** Returns every store to its initial value. Intended for sign-out paths and tests. */
export function resetMitaState(): void {
  batch(() => {
    $writableSessionStatus.set('idle');
    $writableTurnstileStatus.set('idle');
    $writableTurnstileToken.set(null);
  });
}
