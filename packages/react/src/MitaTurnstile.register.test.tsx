import { act, cleanup, render } from '@testing-library/react';
import { MITA_TURNSTILE_TAG } from '@mita-auth/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MitaTurnstile } from './MitaTurnstile';

const { imported } = vi.hoisted(() => ({ imported: vi.fn() }));

// Stubbed rather than left real so this file can watch the import happen. Nothing else
// registers the element here, which is the point: without the component's own import the
// tag would stay unknown.
vi.mock('@mita-auth/client/turnstile', () => {
  imported();
  return {};
});

afterEach(cleanup);

async function mount(): Promise<void> {
  render(<MitaTurnstile siteKey="site" />);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('<MitaTurnstile> registration', () => {
  it('imports the entry that registers the element', async () => {
    expect(customElements.get(MITA_TURNSTILE_TAG)).toBeUndefined();

    await mount();

    expect(imported).toHaveBeenCalledTimes(1);
  });
});
