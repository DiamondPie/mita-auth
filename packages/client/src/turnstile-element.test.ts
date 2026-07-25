import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  $turnstileStatus,
  $turnstileToken,
  consumeTurnstileToken,
  resetMitaState,
} from './state';
import {
  MITA_TURNSTILE_TAG,
  TURNSTILE_SCRIPT_URL,
  defineMitaTurnstile,
  type MitaTurnstileElement,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from './turnstile-element';

defineMitaTurnstile();

let api: TurnstileApi;
let widgets: TurnstileRenderOptions[];
let widgetId: string | undefined;
let events: CustomEvent[];

beforeEach(() => {
  widgets = [];
  widgetId = 'widget-1';
  api = {
    render: vi.fn((_container: HTMLElement, options: TurnstileRenderOptions) => {
      widgets.push(options);
      return widgetId;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;

  events = [];
  for (const type of ['verified', 'expired', 'error']) {
    document.addEventListener(type, collect);
  }

  resetMitaState();
});

afterEach(() => {
  for (const type of ['verified', 'expired', 'error']) {
    document.removeEventListener(type, collect);
  }

  document.body.replaceChildren();
  document.head.replaceChildren();
  delete window.turnstile;
});

function collect(event: Event): void {
  events.push(event as CustomEvent);
}

/** The widget is rendered off an awaited script load, so a macrotask settles everything. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(
  attributes: Record<string, string> = { 'site-key': 'site' },
): Promise<MitaTurnstileElement> {
  const element = document.createElement(MITA_TURNSTILE_TAG);

  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }

  document.body.append(element);
  await flush();

  return element;
}

function options(index = -1): TurnstileRenderOptions {
  const rendered = widgets.at(index);

  if (rendered === undefined) {
    throw new Error('No widget was rendered.');
  }

  return rendered;
}

function lastEvent(): CustomEvent {
  const event = events.at(-1);

  if (event === undefined) {
    throw new Error('No event was dispatched.');
  }

  return event;
}

describe('<mita-turnstile>', () => {
  it('registers itself under its tag', () => {
    expect(customElements.get(MITA_TURNSTILE_TAG)).toBeDefined();
  });

  it('renders into the light DOM with the attributes it was given', async () => {
    const element = await mount({ 'site-key': 'site', theme: 'dark', size: 'compact' });

    expect(options()).toMatchObject({ sitekey: 'site', theme: 'dark', size: 'compact' });
    expect(element.children).toHaveLength(1);
    expect($turnstileStatus.get()).toBe('pending');
  });

  it('leaves out the options the host page did not set', async () => {
    await mount();

    expect(options()).not.toHaveProperty('theme');
    expect(options()).not.toHaveProperty('size');
  });

  it('publishes the token the visitor earns', async () => {
    await mount();

    options().callback?.('token-1');

    expect($turnstileToken.get()).toBe('token-1');
    expect($turnstileStatus.get()).toBe('solved');
    expect(lastEvent().type).toBe('verified');
    expect(lastEvent().detail).toEqual({ token: 'token-1' });
  });

  it('reports a challenge the visitor left too long', async () => {
    await mount();
    options().callback?.('token-1');

    options()['expired-callback']?.();

    expect($turnstileStatus.get()).toBe('expired');
    expect($turnstileToken.get()).toBeNull();
    expect(lastEvent().type).toBe('expired');
  });

  it('passes on the code behind a widget error', async () => {
    await mount();

    options()['error-callback']?.('110200');

    expect($turnstileStatus.get()).toBe('error');
    expect(lastEvent().detail).toEqual({ code: '110200' });
  });

  // The client spends the token the moment it sends one, and the visitor is owed another
  // without having to ask for it.
  it('asks for a fresh challenge once the token has been spent', async () => {
    await mount();
    options().callback?.('token-1');

    expect(consumeTurnstileToken()).toBe('token-1');

    expect(api.reset).toHaveBeenCalledWith('widget-1');
    expect($turnstileStatus.get()).toBe('pending');
  });

  it('replaces the widget when the site key changes', async () => {
    const element = await mount();

    element.setAttribute('site-key', 'other');
    await flush();

    expect(api.remove).toHaveBeenCalledWith('widget-1');
    expect(widgets).toHaveLength(2);
    expect(options().sitekey).toBe('other');
  });

  it('ignores an attribute written back with the value it already had', async () => {
    const element = await mount();

    element.setAttribute('site-key', 'site');
    await flush();

    expect(widgets).toHaveLength(1);
  });

  it('takes the widget down with it when detached', async () => {
    const element = await mount();

    element.remove();

    expect(api.remove).toHaveBeenCalledWith('widget-1');
    expect(element.children).toHaveLength(0);
  });

  it('stops following the state once detached', async () => {
    const element = await mount();
    options().callback?.('token-1');

    element.remove();
    consumeTurnstileToken();

    expect(api.reset).not.toHaveBeenCalled();
  });

  it('reports a missing site key rather than rendering', async () => {
    await mount({});

    expect(api.render).not.toHaveBeenCalled();
    expect($turnstileStatus.get()).toBe('error');
    expect(lastEvent().detail).toEqual({ code: 'missing_site_key' });
  });

  it('reports a widget Cloudflare refused to render', async () => {
    widgetId = undefined;

    await mount();

    expect($turnstileStatus.get()).toBe('error');
    expect(lastEvent().detail).toEqual({ code: 'render_failed' });
  });

  it('waits for a script the page is already loading', async () => {
    delete window.turnstile;
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    document.head.append(script);

    await mount();

    expect(document.head.querySelectorAll('script')).toHaveLength(1);
    expect(api.render).not.toHaveBeenCalled();

    window.turnstile = api;
    script.dispatchEvent(new Event('load'));
    await flush();

    expect(api.render).toHaveBeenCalledTimes(1);
  });

  // happy-dom never fetches the script, so it loads without leaving an API behind — the
  // same place a truncated or blocked response would land.
  it('reports a script that publishes no API', async () => {
    delete window.turnstile;

    await mount();

    expect(document.head.querySelector('script')?.src).toBe(TURNSTILE_SCRIPT_URL);
    expect($turnstileStatus.get()).toBe('error');
    expect(lastEvent().detail).toEqual({ code: 'script_unavailable' });
  });

  it('reports a script the browser refuses to fetch', async () => {
    delete window.turnstile;
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    document.head.append(script);

    await mount();
    script.dispatchEvent(new Event('error'));
    await flush();

    expect($turnstileStatus.get()).toBe('error');
    expect(lastEvent().detail).toEqual({ code: 'script_unavailable' });
  });
});
