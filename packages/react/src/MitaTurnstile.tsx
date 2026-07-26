'use client';

import { createElement, useEffect, useState, type ReactElement } from 'react';
import {
  MITA_TURNSTILE_EVENTS,
  MITA_TURNSTILE_TAG,
  type MitaTurnstileElement,
  type TurnstileRenderOptions,
} from '@mita-auth/client';

export interface MitaTurnstileProps {
  siteKey: string;
  theme?: TurnstileRenderOptions['theme'];
  size?: TurnstileRenderOptions['size'];
  onVerified?: (token: string) => void;
  onExpired?: () => void;
  onError?: (code: string) => void;
}

/**
 * Renders `<mita-turnstile>` and hands its events back as props.
 *
 * The element is reached through a callback ref rather than JSX event props because only
 * React 19 maps `on*` on a custom element to `addEventListener`; React 18 would write
 * `onVerified` as an attribute and never call it. The three attributes are safe to leave
 * to React — the element exposes no properties by those names, so both versions set them
 * as attributes.
 */
export function MitaTurnstile(props: MitaTurnstileProps): ReactElement {
  const { siteKey, theme, size, onVerified, onExpired, onError } = props;
  const [element, setElement] = useState<MitaTurnstileElement | null>(null);

  useEffect(() => {
    // Registration is a side effect kept in its own entry, imported here so it stays out
    // of a server bundle. The registry upgrades the element already in the document, so
    // rendering ahead of this resolving is fine.
    void import('@mita-auth/client/turnstile');
  }, []);

  useEffect(() => {
    if (element === null) {
      return;
    }

    const handleVerified = (event: Event): void => {
      onVerified?.((event as CustomEvent<{ token: string }>).detail.token);
    };
    const handleExpired = (): void => {
      onExpired?.();
    };
    const handleError = (event: Event): void => {
      onError?.((event as CustomEvent<{ code: string }>).detail.code);
    };

    element.addEventListener(MITA_TURNSTILE_EVENTS.verified, handleVerified);
    element.addEventListener(MITA_TURNSTILE_EVENTS.expired, handleExpired);
    element.addEventListener(MITA_TURNSTILE_EVENTS.error, handleError);

    return () => {
      element.removeEventListener(MITA_TURNSTILE_EVENTS.verified, handleVerified);
      element.removeEventListener(MITA_TURNSTILE_EVENTS.expired, handleExpired);
      element.removeEventListener(MITA_TURNSTILE_EVENTS.error, handleError);
    };
  }, [element, onVerified, onExpired, onError]);

  return createElement(MITA_TURNSTILE_TAG, {
    ref: setElement,
    'site-key': siteKey,
    theme,
    size,
  });
}
