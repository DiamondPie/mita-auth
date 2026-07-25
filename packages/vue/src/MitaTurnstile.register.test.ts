import { mount } from '@vue/test-utils';
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

let open: ReturnType<typeof mount> | null = null;

afterEach(() => {
  open?.unmount();
  open = null;
});

describe('<MitaTurnstile> registration', () => {
  it('imports the entry that registers the element', async () => {
    expect(customElements.get(MITA_TURNSTILE_TAG)).toBeUndefined();

    open = mount(MitaTurnstile, { props: { siteKey: 'site' }, attachTo: document.body });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(imported).toHaveBeenCalledTimes(1);
  });
});
