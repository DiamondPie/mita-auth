import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  $isAuthenticated,
  $sessionStatus,
  $turnstileStatus,
  $turnstileToken,
  consumeTurnstileToken,
  expireTurnstileToken,
  markSessionActive,
  markSessionUnauthorized,
  markTurnstileError,
  markTurnstilePending,
  resetMitaState,
  resetTurnstileChallenge,
  setTurnstileToken,
} from './state';

describe('mita state', () => {
  beforeEach(() => {
    resetMitaState();
  });

  it('starts idle, unauthenticated and without a token', () => {
    expect($sessionStatus.get()).toBe('idle');
    expect($isAuthenticated.get()).toBe(false);
    expect($turnstileStatus.get()).toBe('idle');
    expect($turnstileToken.get()).toBeNull();
  });

  describe('session', () => {
    it('turns authenticated once the server accepts a proof', () => {
      markSessionActive();

      expect($sessionStatus.get()).toBe('active');
      expect($isAuthenticated.get()).toBe(true);
    });

    it('drops authentication when the server rejects a proof', () => {
      markSessionActive();
      markSessionUnauthorized();

      expect($sessionStatus.get()).toBe('unauthorized');
      expect($isAuthenticated.get()).toBe(false);
    });

    it('notifies subscribers of $isAuthenticated only when the derived value changes', () => {
      const listener = vi.fn();
      const unsubscribe = $isAuthenticated.listen(listener);

      markSessionActive();
      markSessionActive();

      const [value, oldValue] = listener.mock.lastCall ?? [];

      expect(listener).toHaveBeenCalledTimes(1);
      expect([value, oldValue]).toEqual([true, false]);

      unsubscribe();
    });
  });

  describe('turnstile token', () => {
    it('publishes a solved token', () => {
      setTurnstileToken('token-1');

      expect($turnstileStatus.get()).toBe('solved');
      expect($turnstileToken.get()).toBe('token-1');
    });

    it('hands the token out once and marks it spent', () => {
      setTurnstileToken('token-1');

      expect(consumeTurnstileToken()).toBe('token-1');
      expect($turnstileStatus.get()).toBe('spent');
      expect($turnstileToken.get()).toBeNull();
    });

    it('refuses to hand the same token out twice', () => {
      setTurnstileToken('token-1');
      consumeTurnstileToken();

      expect(consumeTurnstileToken()).toBeNull();
    });

    it('leaves the status alone when there is nothing to consume', () => {
      markTurnstilePending();

      expect(consumeTurnstileToken()).toBeNull();
      expect($turnstileStatus.get()).toBe('pending');
    });

    it.each([
      ['expired', expireTurnstileToken],
      ['error', markTurnstileError],
      ['pending', markTurnstilePending],
    ] as const)('discards the token when the widget reports %s', (status, transition) => {
      setTurnstileToken('token-1');
      transition();

      expect($turnstileStatus.get()).toBe(status);
      expect($turnstileToken.get()).toBeNull();
    });

    it('forgets a spent challenge without disturbing the session', () => {
      markSessionActive();
      setTurnstileToken('token-1');
      consumeTurnstileToken();

      resetTurnstileChallenge();

      expect($turnstileStatus.get()).toBe('idle');
      expect($sessionStatus.get()).toBe('active');
    });

    // The widget resets itself off this transition, so a listener must observe the token
    // and the status already agreeing rather than an intermediate pairing.
    it('never exposes a solved status without its token', () => {
      const pairings: Array<[string, string | null]> = [];
      const unsubscribe = $turnstileStatus.listen(() => {
        pairings.push([$turnstileStatus.get(), $turnstileToken.get()]);
      });

      setTurnstileToken('token-1');
      consumeTurnstileToken();
      expireTurnstileToken();

      expect(pairings).toEqual([
        ['solved', 'token-1'],
        ['spent', null],
        ['expired', null],
      ]);

      unsubscribe();
    });
  });

  it('returns every store to its initial value', () => {
    markSessionActive();
    setTurnstileToken('token-1');

    resetMitaState();

    expect($sessionStatus.get()).toBe('idle');
    expect($isAuthenticated.get()).toBe(false);
    expect($turnstileStatus.get()).toBe('idle');
    expect($turnstileToken.get()).toBeNull();
  });
});
