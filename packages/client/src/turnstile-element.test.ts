import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  $turnstileStatus,
  $turnstileToken,
  consumeTurnstileToken,
  resetMitaState,
} from './state';
import {
  MITA_TURNSTILE_EVENTS,
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
  for (const type of Object.values(MITA_TURNSTILE_EVENTS)) {
    document.addEventListener(type, collect);
  }

  resetMitaState();
});

afterEach(() => {
  for (const type of Object.values(MITA_TURNSTILE_EVENTS)) {
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
    expect(lastEvent().type).toBe(MITA_TURNSTILE_EVENTS.verified);
    expect(lastEvent().detail).toEqual({ token: 'token-1' });
  });

  it('reports a challenge the visitor left too long', async () => {
    await mount();
    options().callback?.('token-1');

    options()['expired-callback']?.();

    expect($turnstileStatus.get()).toBe('expired');
    expect($turnstileToken.get()).toBeNull();
    expect(lastEvent().type).toBe(MITA_TURNSTILE_EVENTS.expired);
  });

  it('passes on the code behind a widget error', async () => {
    await mount();

    options()['error-callback']?.('110200');

    expect($turnstileStatus.get()).toBe('error');
    expect(lastEvent().detail).toEqual({ code: '110200' });
  });

  // The event bubbles and is composed, so an unprefixed `error` would reach `window`, where
  // front-end monitoring listens. A visitor who failed a challenge is not a page error.
  it('does not report a failed challenge to a page-level error handler', async () => {
    const onPageError = vi.fn();
    window.addEventListener('error', onPageError);

    try {
      await mount();
      options()['error-callback']?.('110200');

      expect(lastEvent().type).toBe(MITA_TURNSTILE_EVENTS.error);
      expect(onPageError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', onPageError);
    }
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

  // Nothing on screen can clear a spent challenge once the widget is gone, and every later
  // request would be sent without a token.
  it('clears a spent challenge it has no widget left to reset', async () => {
    const element = await mount();
    options().callback?.('token-1');
    element.remove();

    expect(consumeTurnstileToken()).toBe('token-1');
    element.reset();

    expect(api.reset).not.toHaveBeenCalled();
    expect($turnstileStatus.get()).toBe('idle');
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

  // A script the page already carried may have finished loading before this element ran, in
  // which case `load` never fires again. Without a backstop the widget sits at `pending` for
  // as long as the page lives, with no error anywhere to explain it.
  it('gives up on a script that reports neither success nor failure', async () => {
    vi.useFakeTimers();
    delete window.turnstile;

    try {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT_URL;
      document.head.append(script);

      const element = document.createElement(MITA_TURNSTILE_TAG);
      element.setAttribute('site-key', 'site');
      document.body.append(element);

      await vi.advanceTimersByTimeAsync(10_000);

      expect($turnstileStatus.get()).toBe('error');
      expect(lastEvent().detail).toEqual({ code: 'script_unavailable' });
    } finally {
      vi.useRealTimers();
    }
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
