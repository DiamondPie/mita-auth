import { MitaError } from '@mita-auth/core';

import {
  $turnstileStatus,
  expireTurnstileToken,
  markTurnstileError,
  markTurnstilePending,
  resetTurnstileChallenge,
  setTurnstileToken,
} from './state';

export const MITA_TURNSTILE_TAG = 'mita-turnstile';

/**
 * Names the element dispatches under, all prefixed.
 *
 * `error` on its own would have been the costly one: the event bubbles and is composed, so
 * it reaches `window`, where front-end monitoring almost universally listens — a visitor who
 * simply failed a challenge would be reported as a page error. The other two are prefixed
 * for the sake of one consistent set rather than because anything collides with them.
 */
export const MITA_TURNSTILE_EVENTS = {
  verified: 'mita-verified',
  expired: 'mita-expired',
  error: 'mita-error',
} as const;

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Backstop for a script load that reports neither success nor failure. */
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;

export interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'compact' | 'flexible';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (code?: string) => void;
}

/** The part of Cloudflare's explicit rendering API this element drives. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }

  interface HTMLElementTagNameMap {
    'mita-turnstile': MitaTurnstileElement;
  }
}

/**
 * `HTMLElement` is absent while a framework renders on the server, and a class declaration
 * would reach for it at import time. Importing this module stays harmless there; only
 * registration needs a browser.
 */
const ElementBase =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/**
 * Renders a Turnstile widget and keeps the shared state in step with it.
 *
 * The widget lives in the light DOM: Cloudflare injects an iframe into whatever container
 * it is handed, and a shadow boundary is one more thing between that iframe and the host
 * page's styling for no isolation this element needs.
 *
 * A solved token is published to `$turnstileToken`, where `createProtectedClient` picks it
 * up. Sending spends it, so the element watches for that and asks for a fresh challenge
 * without waiting to be told.
 */
export class MitaTurnstileElement extends ElementBase {
  static readonly observedAttributes = ['site-key', 'theme', 'size'];

  #api?: TurnstileApi;
  #widgetId?: string;
  #unlisten?: () => void;
  /** Tells renders apart, so a slow script load cannot revive one that was superseded. */
  #generation = 0;

  connectedCallback(): void {
    this.#unlisten = $turnstileStatus.listen((status) => {
      if (status === 'spent') {
        this.reset();
      }
    });

    void this.#render();
  }

  disconnectedCallback(): void {
    // Unsubscribing first: the reset below writes to the same store this listener watches,
    // and a `spent` status arriving here would call back into a widget already being torn
    // down.
    this.#unlisten?.();
    this.#unlisten = undefined;
    this.#destroyWidget();
    // Every status but `idle` describes a widget that no longer exists, and nothing left on
    // screen could clear it. A solved token goes with it: `remove()` above already orphaned
    // the challenge it came from.
    resetTurnstileChallenge();
  }

  attributeChangedCallback(_name: string, previous: string | null, next: string | null): void {
    if (previous !== next && this.isConnected) {
      void this.#render();
    }
  }

  /** Discards the current challenge and asks Cloudflare for another. */
  reset(): void {
    if (this.#api === undefined || this.#widgetId === undefined) {
      // There is no widget to ask. Leaving a spent challenge on record would strand every
      // later request without a token, with nothing left on screen able to clear it.
      resetTurnstileChallenge();
      return;
    }

    markTurnstilePending();
    this.#api.reset(this.#widgetId);
  }

  async #render(): Promise<void> {
    const siteKey = this.getAttribute('site-key');
    const generation = ++this.#generation;

    this.#destroyWidget();

    if (siteKey === null) {
      this.#fail('missing_site_key');
      return;
    }

    markTurnstilePending();

    let api: TurnstileApi;

    try {
      api = await loadTurnstile();
    } catch {
      if (generation === this.#generation) {
        this.#fail('script_unavailable');
      }

      return;
    }

    // Whatever happened while the script loaded — a detach, another render — owns the
    // element now.
    if (generation !== this.#generation || !this.isConnected) {
      return;
    }

    const theme = this.getAttribute('theme');
    const size = this.getAttribute('size');
    const container = document.createElement('div');

    this.replaceChildren(container);

    const widgetId = api.render(container, {
      sitekey: siteKey,
      // Cloudflare is the one that validates these; a typo should reach it, not be
      // swallowed here.
      ...(theme === null ? {} : { theme: theme as NonNullable<TurnstileRenderOptions['theme']> }),
      ...(size === null ? {} : { size: size as NonNullable<TurnstileRenderOptions['size']> }),
      callback: (token) => {
        setTurnstileToken(token);
        this.#emit(MITA_TURNSTILE_EVENTS.verified, { token });
      },
      'expired-callback': () => {
        expireTurnstileToken();
        this.#emit(MITA_TURNSTILE_EVENTS.expired, null);
      },
      'error-callback': (code) => {
        this.#fail(code ?? 'unknown');
      },
    });

    if (widgetId === undefined) {
      this.#fail('render_failed');
      return;
    }

    this.#api = api;
    this.#widgetId = widgetId;
  }

  #destroyWidget(): void {
    if (this.#api !== undefined && this.#widgetId !== undefined) {
      this.#api.remove(this.#widgetId);
    }

    this.#api = undefined;
    this.#widgetId = undefined;
    this.replaceChildren();
  }

  #fail(code: string): void {
    markTurnstileError();
    this.#emit(MITA_TURNSTILE_EVENTS.error, { code });
  }

  #emit<TDetail>(type: string, detail: TDetail): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

/**
 * Registers `<mita-turnstile>`.
 *
 * A no-op where there is no custom element registry, and where the tag is already taken —
 * two copies of this package on one page should not throw at import time.
 */
export function defineMitaTurnstile(tag: string = MITA_TURNSTILE_TAG): void {
  if (typeof customElements === 'undefined' || customElements.get(tag) !== undefined) {
    return;
  }

  customElements.define(tag, MitaTurnstileElement);
}

/**
 * Resolves once Cloudflare's script has published its API.
 *
 * Deduplication is left to the DOM rather than a module-level promise, so a page that
 * already carries the script — added by hand, or by another widget — is the same case as
 * one this element had to inject.
 */
function loadTurnstile(): Promise<TurnstileApi> {
  const ready = window.turnstile;

  if (ready !== undefined) {
    return Promise.resolve(ready);
  }

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${TURNSTILE_SCRIPT_URL}"]`,
  );
  const script = existing ?? createTurnstileScript();

  const settled = new Promise<TurnstileApi>((resolve, reject) => {
    const fail = (): void => {
      clearTimeout(timer);
      reject(
        new MitaError(
          'client.turnstile_script_unavailable',
          `Could not load the Turnstile script from ${TURNSTILE_SCRIPT_URL}.`,
        ),
      );
    };

    // Reusing a script the page already carries means inheriting whatever state it is in,
    // and a script that finished loading before this ran will never fire `load` again. If
    // an extension or a CSP kept it from publishing an API, nothing would ever settle this
    // promise and the widget would sit at `pending` for as long as the page lived.
    const timer = setTimeout(fail, SCRIPT_LOAD_TIMEOUT_MS);

    script.addEventListener(
      'load',
      () => {
        const api = window.turnstile;

        if (api === undefined) {
          fail();
          return;
        }

        clearTimeout(timer);
        resolve(api);
      },
      { once: true },
    );

    script.addEventListener('error', fail, { once: true });
  });

  // Inserting is what starts the load, so it happens once there is something listening.
  if (existing === null) {
    document.head.append(script);
  }

  return settled;
}

function createTurnstileScript(): HTMLScriptElement {
  const script = document.createElement('script');

  script.src = TURNSTILE_SCRIPT_URL;
  script.async = true;

  return script;
}
