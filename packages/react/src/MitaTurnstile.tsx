'use client';

import { useEffect, useRef } from 'react';
import { MITA_TURNSTILE_TAG, type MitaTurnstileElement, type TurnstileRenderOptions } from '@mita-auth/client';

export interface MitaTurnstileProps {
  siteKey: string;
  theme?: TurnstileRenderOptions['theme'];
  size?: TurnstileRenderOptions['size'];
  onVerified?: (token: string) => void;
  onExpired?: () => void;
  onError?: (code: string) => void;
}

/**
 * React 18 has no notion of custom-element properties or events — it would write
 * `onVerified` as a DOM attribute and never call it. The element is therefore created and
 * wired up by hand instead of through JSX, which works identically on 18 and 19 and skips
 * needing a `JSX.IntrinsicElements['mita-turnstile']` augmentation altogether.
 */
export function MitaTurnstile(props: MitaTurnstileProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<MitaTurnstileElement | null>(null);
  const { siteKey, theme, size, onVerified, onExpired, onError } = props;

  useEffect(() => {
    const container = containerRef.current;

    if (container === null) {
      return;
    }

    const element = document.createElement(MITA_TURNSTILE_TAG) as MitaTurnstileElement;

    elementRef.current = element;
    container.append(element);
    // Registering is what upgrades `element` from a plain HTMLElement — the custom
    // elements spec upgrades already-connected instances the moment `define()` runs, so
    // creating it ahead of the (possibly code-split) registration is safe.
    void import('@mita-auth/client/turnstile');

    return () => {
      element.remove();
      elementRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;

    if (element === null) {
      return;
    }

    element.setAttribute('site-key', siteKey);

    if (theme === undefined) {
      element.removeAttribute('theme');
    } else {
      element.setAttribute('theme', theme);
    }

    if (size === undefined) {
      element.removeAttribute('size');
    } else {
      element.setAttribute('size', size);
    }
  }, [siteKey, theme, size]);

  useEffect(() => {
    const element = elementRef.current;

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

    element.addEventListener('verified', handleVerified);
    element.addEventListener('expired', handleExpired);
    element.addEventListener('error', handleError);

    return () => {
      element.removeEventListener('verified', handleVerified);
      element.removeEventListener('expired', handleExpired);
      element.removeEventListener('error', handleError);
    };
  }, [onVerified, onExpired, onError]);

  return <div ref={containerRef} />;
}
