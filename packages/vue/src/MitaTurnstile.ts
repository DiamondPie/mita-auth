import { defineComponent, h, onMounted, type PropType } from 'vue';
import { MITA_TURNSTILE_TAG, type TurnstileRenderOptions } from '@mita-auth/client';

/**
 * Renders `<mita-turnstile>` and re-emits its events.
 *
 * Vue's own patching does all the work here: `site-key`/`theme`/`size` are not properties
 * of the element, so they go through `setAttribute`, and the `on*` keys hyphenate down to
 * the event names the element dispatches. No manual `addEventListener`, unlike the React
 * wrapper.
 *
 * A render function rather than a template also means the tag never reaches Vue's template
 * compiler — which is why this package needs no `compilerOptions.isCustomElement`. A host
 * page writing `<mita-turnstile>` in its own template still would; using this component
 * instead is the way around that.
 */
export const MitaTurnstile = defineComponent({
  name: 'MitaTurnstile',
  props: {
    siteKey: { type: String, required: true },
    theme: { type: String as PropType<TurnstileRenderOptions['theme']>, default: undefined },
    size: { type: String as PropType<TurnstileRenderOptions['size']>, default: undefined },
  },
  emits: {
    verified: (_token: string) => true,
    expired: () => true,
    error: (_code: string) => true,
  },
  setup(props, { emit }) {
    onMounted(() => {
      // Registration is a side effect kept in its own entry, imported here so it stays out
      // of a server bundle. The registry upgrades the element already in the document, so
      // rendering ahead of this resolving is fine.
      void import('@mita-auth/client/turnstile');
    });

    return () =>
      h(MITA_TURNSTILE_TAG, {
        'site-key': props.siteKey,
        theme: props.theme,
        size: props.size,
        // Vue hyphenates an `on*` key down to the DOM event name, so these three land on
        // `mita-verified` / `mita-expired` / `mita-error`. The component's own emits keep
        // the short names — the prefix exists to keep the element's `error` off `window`,
        // which is not a concern once Vue is the one routing it.
        onMitaVerified: (event: Event) => {
          emit('verified', (event as CustomEvent<{ token: string }>).detail.token);
        },
        onMitaExpired: () => {
          emit('expired');
        },
        onMitaError: (event: Event) => {
          emit('error', (event as CustomEvent<{ code: string }>).detail.code);
        },
      });
  },
});
