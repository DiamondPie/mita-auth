import { mount, type VueWrapper } from '@vue/test-utils';
import {
  MITA_TURNSTILE_TAG,
  resetMitaState,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from '@mita-auth/client';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The component registers the element itself, but happy-dom swaps the node when it upgrades
// one already in the document — against the spec, and enough to leave Vue holding a
// detached reference. Registering up front sidesteps an environment quirk the browser does
// not have; `MitaTurnstile.register.test.ts` covers the import itself.
import '@mita-auth/client/turnstile';

import { MitaTurnstile } from './MitaTurnstile';

interface Props {
  siteKey?: string;
  theme?: TurnstileRenderOptions['theme'];
  size?: TurnstileRenderOptions['size'];
  onVerified?: (token: string) => void;
}

let api: TurnstileApi;
let widgets: TurnstileRenderOptions[];
let open: VueWrapper | null = null;

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
  unmount();
  document.head.replaceChildren();
  delete window.turnstile;
});

/** The element renders off an awaited script load, so a macrotask settles a mount. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mounted(props: Props = {}): Promise<VueWrapper> {
  open = mount(MitaTurnstile, { props: { siteKey: 'site', ...props } });

  // The element upgrades and connects only inside a document, and Vue takes it back out on
  // unmount wherever it sits. Moving it by hand rather than through the `attachTo` option,
  // which reaches for `app.onUnmount` — a Vue 3.5 API, above this package's peer floor.
  document.body.append(open.element);

  await flush();

  return open;
}

function unmount(): void {
  open?.unmount();
  open = null;
}

function options(index = -1): TurnstileRenderOptions {
  const rendered = widgets.at(index);

  if (rendered === undefined) {
    throw new Error('No widget was rendered.');
  }

  return rendered;
}

describe('<MitaTurnstile>', () => {
  it('renders a widget for the site key it was given', async () => {
    await mounted();

    expect(options()).toMatchObject({ sitekey: 'site' });
  });

  it('mirrors the optional props onto the element', async () => {
    const wrapper = await mounted({ theme: 'dark', size: 'compact' });

    expect(wrapper.attributes('theme')).toBe('dark');
    expect(wrapper.attributes('size')).toBe('compact');
    expect(options()).toMatchObject({ theme: 'dark', size: 'compact' });
  });

  it('leaves out the props the host page did not pass', async () => {
    const wrapper = await mounted();

    expect(wrapper.attributes('theme')).toBeUndefined();
    expect(wrapper.attributes('size')).toBeUndefined();
  });

  it('drops an attribute the host page stops passing', async () => {
    const wrapper = await mounted({ theme: 'dark' });

    await wrapper.setProps({ theme: undefined });
    await flush();

    expect(wrapper.attributes('theme')).toBeUndefined();
  });

  it('re-renders the widget when the site key changes', async () => {
    const wrapper = await mounted();

    await wrapper.setProps({ siteKey: 'other' });
    await flush();

    expect(options().sitekey).toBe('other');
  });

  it('re-emits the token the visitor earned', async () => {
    const wrapper = await mounted();

    options().callback?.('token-1');
    await flush();

    expect(wrapper.emitted('verified')).toEqual([['token-1']]);
  });

  it('re-emits a challenge the visitor left too long', async () => {
    const wrapper = await mounted();

    options()['expired-callback']?.();
    await flush();

    expect(wrapper.emitted('expired')).toEqual([[]]);
  });

  it('re-emits the code behind a widget error', async () => {
    const wrapper = await mounted();

    options()['error-callback']?.('110200');
    await flush();

    expect(wrapper.emitted('error')).toEqual([['110200']]);
  });

  // Declaring `emits` is what keeps this honest: an undeclared listener would also fall
  // through to the root element and reach the host page with the raw DOM event.
  it("hands the host page's listener the token rather than the event", async () => {
    const onVerified = vi.fn();
    await mounted({ onVerified });

    options().callback?.('token-1');
    await flush();

    expect(onVerified).toHaveBeenCalledExactlyOnceWith('token-1');
  });

  it('takes the element down when unmounted', async () => {
    await mounted();

    unmount();

    expect(document.querySelector(MITA_TURNSTILE_TAG)).toBeNull();
    expect(api.remove).toHaveBeenCalledWith('widget-1');
  });
});
