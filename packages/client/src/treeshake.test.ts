/**
 * @vitest-environment node
 *
 * Runs the state module through a real bundler before exercising it.
 *
 * Every other test here imports the source directly, which no tree-shaker has touched — so
 * none of them can see a writer that only stops working once an application bundles this
 * package. That is not hypothetical: nanostores publishes `batch()` with a
 * `@__NO_SIDE_EFFECTS__` annotation, and an earlier version of `state.ts` wrapped its
 * writers in it. A bundler is entitled to delete such a call when its result goes unused,
 * which turned all six writers into empty functions and left the Turnstile integration
 * silently dead in production while every unit test stayed green.
 *
 * Deliberately free of Node APIs, like the rest of this package: `@types/node` is absent on
 * purpose, so a Node-only call in `client.ts` fails to compile rather than passing review.
 */
import { rolldown } from 'rolldown';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as stateModule from './state';

type StateModule = typeof stateModule;

/**
 * The bundle needs no import map or temporary file: `state.ts` reaches for nothing but
 * nanostores, which gets inlined, leaving a self-contained module a data URL can load.
 */
async function bundleStateModule(): Promise<StateModule> {
  const bundle = await rolldown({ input: 'src/state.ts', platform: 'browser' });

  try {
    const { output } = await bundle.generate({ format: 'esm' });

    return (await import(
      `data:text/javascript,${encodeURIComponent(output[0].code)}`
    )) as StateModule;
  } finally {
    await bundle.close();
  }
}

describe('bundled state module', () => {
  let state: StateModule;

  beforeAll(async () => {
    state = await bundleStateModule();
  }, 60_000);

  beforeEach(() => {
    state.resetMitaState();
  });

  it('publishes a solved token', () => {
    state.setTurnstileToken('bundled-token');

    expect(state.$turnstileStatus.get()).toBe('solved');
    expect(state.$turnstileToken.get()).toBe('bundled-token');
  });

  it('spends the token exactly once', () => {
    state.setTurnstileToken('bundled-token');

    expect(state.consumeTurnstileToken()).toBe('bundled-token');
    expect(state.$turnstileStatus.get()).toBe('spent');
    expect(state.consumeTurnstileToken()).toBeNull();
  });

  it.each([
    ['markTurnstilePending', 'pending'],
    ['expireTurnstileToken', 'expired'],
    ['markTurnstileError', 'error'],
  ] as const)('still applies %s', (writer, status) => {
    state.setTurnstileToken('bundled-token');
    state[writer]();

    expect(state.$turnstileStatus.get()).toBe(status);
    expect(state.$turnstileToken.get()).toBeNull();
  });

  it('still applies the session writers', () => {
    state.markSessionActive();
    expect(state.$isAuthenticated.get()).toBe(true);

    state.markSessionUnauthorized();
    expect(state.$sessionStatus.get()).toBe('unauthorized');
  });

  it('still resets every store', () => {
    state.markSessionActive();
    state.setTurnstileToken('bundled-token');

    state.resetMitaState();

    expect(state.$sessionStatus.get()).toBe('idle');
    expect(state.$turnstileStatus.get()).toBe('idle');
    expect(state.$turnstileToken.get()).toBeNull();
  });
});
