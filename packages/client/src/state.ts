/**
 * Shared reactive state for one browser tab.
 *
 * The atoms below are module-level, which in a browser is exactly one per page and in a
 * server process is exactly one per **process** — shared by every request it handles. That
 * is safe today only because every writer runs in the browser: the client's hooks, and the
 * Turnstile element. Nothing enforces it. Calling `markSessionActive()` from a server
 * component or a route handler would leak one visitor's session state to the next, so treat
 * this module as browser-only and read-only on the server.
 *
 * A second copy of `@mita-auth/client` on one page has the same shape of problem from the
 * other direction: `<mita-turnstile>` and `createProtectedClient` would bind to different
 * stores, and the symptom is a widget that visibly solves while every request comes back
 * `403 turnstile_missing`.
 */
import { atom, computed, readonlyType, type ReadableAtom } from 'nanostores';

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

/**
 * The widget's status and its token, held as one value.
 *
 * They describe a single fact between them, so they are stored together rather than kept in
 * step by hand: one `set` cannot leave a subscriber looking at a `solved` status with no
 * token, or a `spent` one that still has it. An earlier version paired two atoms inside
 * nanostores' `batch()`, which reads the same but is not equivalent — `batch` is published
 * with a `@__NO_SIDE_EFFECTS__` annotation, so a bundler is entitled to delete a call whose
 * result goes unused, and every writer below silently became a no-op in a production build.
 */
interface TurnstileChallenge {
  readonly status: TurnstileStatus;
  readonly token: string | null;
}

const IDLE_CHALLENGE: TurnstileChallenge = { status: 'idle', token: null };

const $writableSessionStatus = atom<SessionStatus>('idle');
const $writableTurnstile = atom<TurnstileChallenge>(IDLE_CHALLENGE);

export const $sessionStatus: ReadableAtom<SessionStatus> = readonlyType($writableSessionStatus);

/**
 * Whether the server has accepted a proof from this browser's key pair.
 *
 * **This is not a sign-in.** Mita's DPoP exchange proves that a request was signed by
 * whoever holds a given private key and that the same key signed the ones before it — never
 * who that is. Any visitor generates a key pair on their first request and turns this `true`,
 * so gating anything that matters on it grants it to everyone. It answers "can this browser
 * talk to the guard", not "who is this".
 */
export const $hasProvenKey: ReadableAtom<boolean> = computed(
  $writableSessionStatus,
  (status) => status === 'active',
);

export const $turnstileStatus: ReadableAtom<TurnstileStatus> = computed(
  $writableTurnstile,
  (challenge) => challenge.status,
);

/**
 * The unspent Turnstile token, or `null` when there is nothing to send.
 *
 * A view onto the same value {@link $turnstileStatus} reads, so the two can never disagree.
 */
export const $turnstileToken: ReadableAtom<string | null> = computed(
  $writableTurnstile,
  (challenge) => challenge.token,
);

export function markSessionActive(): void {
  $writableSessionStatus.set('active');
}

export function markSessionUnauthorized(): void {
  $writableSessionStatus.set('unauthorized');
}

/** Announces that a widget is on screen and waiting on the visitor. */
export function markTurnstilePending(): void {
  $writableTurnstile.set({ status: 'pending', token: null });
}

export function setTurnstileToken(token: string): void {
  $writableTurnstile.set({ status: 'solved', token });
}

/**
 * Hands the token to a request and marks it spent.
 *
 * Cloudflare's `siteverify` accepts a token exactly once, so a token that has been sent
 * must never be sent again — the widget has to produce a fresh one, which it does by
 * watching for this transition.
 */
export function consumeTurnstileToken(): string | null {
  const { token } = $writableTurnstile.get();

  if (token === null) {
    return null;
  }

  $writableTurnstile.set({ status: 'spent', token: null });

  return token;
}

export function expireTurnstileToken(): void {
  $writableTurnstile.set({ status: 'expired', token: null });
}

export function markTurnstileError(): void {
  $writableTurnstile.set({ status: 'error', token: null });
}

/**
 * Forgets the current challenge without touching the session.
 *
 * For the moment no widget is in a position to describe one: `spent` and `error` both say
 * something about a widget that is no longer there, and a widget mounting later can only
 * take over from `idle`.
 */
export function resetTurnstileChallenge(): void {
  $writableTurnstile.set(IDLE_CHALLENGE);
}

/**
 * Returns every store to its initial value. Intended for sign-out paths and tests.
 *
 * The two writes are not coordinated because nothing derives from both atoms at once; the
 * only pairing that has to hold is inside {@link $writableTurnstile}, and that is one value.
 */
export function resetMitaState(): void {
  $writableSessionStatus.set('idle');
  $writableTurnstile.set(IDLE_CHALLENGE);
}
