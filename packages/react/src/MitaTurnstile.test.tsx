import { act, cleanup, render } from '@testing-library/react';
import {
  MITA_TURNSTILE_TAG,
  resetMitaState,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from '@mita-auth/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The component registers the element itself, but happy-dom swaps the node when it
// upgrades one already in the document — against the spec, and enough to leave React
// holding a detached reference. Registering up front sidesteps an environment quirk the
// browser does not have; `MitaTurnstile.register.test.tsx` covers the import itself.
import '@mita-auth/client/turnstile';

import { MitaTurnstile, type MitaTurnstileProps } from './MitaTurnstile';

let api: TurnstileApi;
let widgets: TurnstileRenderOptions[];

beforeEach(() => {
  widgets = [];
  api = {
    render: vi.fn((_container: HTMLElement, rendered: TurnstileRenderOptions) => {
      widgets.push(rendered);
      return `widget-${String(widgets.length)}`;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;

  resetMitaState();
});

afterEach(() => {
  cleanup();
  document.head.replaceChildren();
  delete window.turnstile;
});

/** The element renders off an awaited script load, so a macrotask settles a mount. */
function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function element(): Element {
  const found = document.querySelector(MITA_TURNSTILE_TAG);

  if (found === null) {
    throw new Error('The component rendered no element.');
  }

  return found;
}

function options(index = -1): TurnstileRenderOptions {
  const rendered = widgets.at(index);

  if (rendered === undefined) {
    throw new Error('No widget was rendered.');
  }

  return rendered;
}

async function mount(props: Partial<MitaTurnstileProps> = {}) {
  const result = render(<MitaTurnstile siteKey="site" {...props} />);

  await flush();

  return result;
}

describe('<MitaTurnstile>', () => {
  it('renders a widget for the site key it was given', async () => {
    await mount();

    expect(options()).toMatchObject({ sitekey: 'site' });
  });

  it('mirrors the optional props onto the element', async () => {
    await mount({ theme: 'dark', size: 'compact' });

    expect(element().getAttribute('theme')).toBe('dark');
    expect(element().getAttribute('size')).toBe('compact');
    expect(options()).toMatchObject({ theme: 'dark', size: 'compact' });
  });

  it('leaves out the props the host page did not pass', async () => {
    await mount();

    expect(element().hasAttribute('theme')).toBe(false);
    expect(element().hasAttribute('size')).toBe(false);
  });

  it('drops an attribute the host page stops passing', async () => {
    const { rerender } = await mount({ theme: 'dark' });

    rerender(<MitaTurnstile siteKey="site" />);
    await flush();

    expect(element().hasAttribute('theme')).toBe(false);
  });

  it('re-renders the widget when the site key changes', async () => {
    const { rerender } = await mount();

    rerender(<MitaTurnstile siteKey="other" />);
    await flush();

    expect(options().sitekey).toBe('other');
  });

  it('forwards the token the visitor earned', async () => {
    const onVerified = vi.fn();
    await mount({ onVerified });

    await act(async () => {
      options().callback?.('token-1');
    });

    expect(onVerified).toHaveBeenCalledWith('token-1');
  });

  it('forwards a challenge the visitor left too long', async () => {
    const onExpired = vi.fn();
    await mount({ onExpired });

    await act(async () => {
      options()['expired-callback']?.();
    });

    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('forwards the code behind a widget error', async () => {
    const onError = vi.fn();
    await mount({ onError });

    await act(async () => {
      options()['error-callback']?.('110200');
    });

    expect(onError).toHaveBeenCalledWith('110200');
  });

  it('takes the element down when unmounted', async () => {
    const { unmount } = await mount();

    unmount();

    expect(document.querySelector(MITA_TURNSTILE_TAG)).toBeNull();
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });

  it('ignores the events a host page passed no handler for', async () => {
    await mount();

    await act(async () => {
      options().callback?.('token-1');
      options()['expired-callback']?.();
      options()['error-callback']?.('110200');
    });

    expect(element()).toBeInstanceOf(HTMLElement);
  });

  it('stops forwarding events once unmounted', async () => {
    const onVerified = vi.fn();
    const { unmount } = await mount({ onVerified });
    const solved = options().callback;

    unmount();
    solved?.('token-1');

    expect(onVerified).not.toHaveBeenCalled();
  });
});
