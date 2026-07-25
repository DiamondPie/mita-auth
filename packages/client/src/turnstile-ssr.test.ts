/**
 * @vitest-environment node
 *
 * Next.js and Nuxt import the package while rendering on the server, where there is no
 * DOM at all. A class declaration reaches for its base at import time, so this is the one
 * failure that would strike before any component had a chance to run.
 */
import { describe, expect, it } from 'vitest';

describe('server rendering', () => {
  it('imports without a DOM', async () => {
    const { MitaTurnstileElement } = await import('./turnstile-element');

    expect(MitaTurnstileElement).toBeTypeOf('function');
  });

  it('leaves the element unregistered instead of throwing', async () => {
    const { defineMitaTurnstile } = await import('./turnstile-element');

    expect(() => {
      defineMitaTurnstile();
    }).not.toThrow();
  });

  it('survives the side-effecting entry point', async () => {
    await expect(import('./turnstile')).resolves.toBeDefined();
  });
});
