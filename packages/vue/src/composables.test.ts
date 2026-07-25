import { mount, type VueWrapper } from '@vue/test-utils';
import {
  $turnstileToken,
  markSessionActive,
  markSessionUnauthorized,
  resetMitaState,
  setTurnstileToken,
} from '@mita-auth/client';
import { defineComponent, h, nextTick, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useIsAuthenticated,
  useSessionStatus,
  useTurnstileStatus,
  useTurnstileToken,
} from './composables';

const Probe = defineComponent({
  setup() {
    const isAuthenticated = useIsAuthenticated();
    const sessionStatus = useSessionStatus();
    const turnstileStatus = useTurnstileStatus();
    const turnstileToken = useTurnstileToken();

    return () =>
      h('ul', [
        h('li', { 'data-store': 'isAuthenticated' }, String(isAuthenticated.value)),
        h('li', { 'data-store': 'sessionStatus' }, sessionStatus.value),
        h('li', { 'data-store': 'turnstileStatus' }, turnstileStatus.value),
        h('li', { 'data-store': 'turnstileToken' }, turnstileToken.value ?? 'none'),
      ]);
  },
});

let open: VueWrapper | null = null;

function mounted(component: Component): VueWrapper {
  open = mount(component);

  return open;
}

function unmountAll(): void {
  open?.unmount();
  open = null;
}

function read(wrapper: VueWrapper): Record<string, string> {
  return {
    isAuthenticated: wrapper.get('[data-store="isAuthenticated"]').text(),
    sessionStatus: wrapper.get('[data-store="sessionStatus"]').text(),
    turnstileStatus: wrapper.get('[data-store="turnstileStatus"]').text(),
    turnstileToken: wrapper.get('[data-store="turnstileToken"]').text(),
  };
}

beforeEach(() => {
  resetMitaState();
});

// The stores are module-level singletons, so a wrapper left mounted would keep answering
// the next test's mutations.
afterEach(unmountAll);

describe('composables', () => {
  it('renders the initial value of every store', () => {
    const wrapper = mounted(Probe);

    expect(read(wrapper)).toEqual({
      isAuthenticated: 'false',
      sessionStatus: 'idle',
      turnstileStatus: 'idle',
      turnstileToken: 'none',
    });
  });

  it('re-renders once the server accepts a proof', async () => {
    const wrapper = mounted(Probe);

    markSessionActive();
    await nextTick();

    expect(read(wrapper)).toMatchObject({ isAuthenticated: 'true', sessionStatus: 'active' });
  });

  it('re-renders once the server rejects a proof', async () => {
    const wrapper = mounted(Probe);

    markSessionActive();
    markSessionUnauthorized();
    await nextTick();

    expect(read(wrapper)).toMatchObject({
      isAuthenticated: 'false',
      sessionStatus: 'unauthorized',
    });
  });

  it('re-renders with the token the visitor earned', async () => {
    const wrapper = mounted(Probe);

    setTurnstileToken('token-1');
    await nextTick();

    expect(read(wrapper)).toMatchObject({ turnstileStatus: 'solved', turnstileToken: 'token-1' });
  });

  it('falls back to the initial values once the state is reset', async () => {
    const wrapper = mounted(Probe);

    markSessionActive();
    setTurnstileToken('token-1');
    resetMitaState();
    await nextTick();

    expect(read(wrapper)).toEqual({
      isAuthenticated: 'false',
      sessionStatus: 'idle',
      turnstileStatus: 'idle',
      turnstileToken: 'none',
    });
  });

  // One composable per store exists for this: a component that only cares about the widget
  // should not repaint every time the session moves.
  it('leaves a component subscribed to another store alone', async () => {
    const rendered = vi.fn();

    mounted(
      defineComponent({
        setup() {
          const status = useTurnstileStatus();

          return () => {
            rendered();
            return h('span', status.value);
          };
        },
      }),
    );
    const before = rendered.mock.calls.length;

    markSessionActive();
    await nextTick();

    expect(rendered.mock.calls).toHaveLength(before);
  });

  // useStore hands its teardown to onScopeDispose, which only exists because the composable
  // was called inside setup(). Counting listeners is the only way to see it happen.
  it('drops its subscription when the component goes away', () => {
    const before = $turnstileToken.lc;

    mounted(
      defineComponent({
        setup() {
          const token = useTurnstileToken();

          return () => h('span', token.value ?? 'none');
        },
      }),
    );

    expect($turnstileToken.lc).toBe(before + 1);

    unmountAll();

    expect($turnstileToken.lc).toBe(before);
  });
});
