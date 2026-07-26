# @mita-auth/vue

Vue 3 bindings for [Mita](https://github.com/DiamondPie/mita-auth): four composables over
`@mita-auth/client`'s nanostores state, and a `<MitaTurnstile>` component wrapping the
`<mita-turnstile>` custom element.

> 🚧 In development. Nothing is published to npm yet, and the public API may still change.

## Install

```bash
pnpm add @mita-auth/vue @mita-auth/client
```

Peer: `vue@^3.3.1` — the floor comes from `@nanostores/vue`, which needs the effect-scope
API this package relies on.

## Usage

```vue
<script setup lang="ts">
import { MitaTurnstile, useIsAuthenticated, useTurnstileStatus } from '@mita-auth/vue';

const authenticated = useIsAuthenticated();
const turnstile = useTurnstileStatus();
</script>

<template>
  <form>
    <!-- … -->
    <MitaTurnstile :site-key="siteKey" @error="(code) => console.warn(code)" />
    <button :disabled="turnstile !== 'solved'">Post</button>
    <span v-if="authenticated">session active</span>
  </form>
</template>
```

## Exports

| Composable | Reads |
| --- | --- |
| `useIsAuthenticated()` | whether the server has accepted a proof from this browser |
| `useSessionStatus()` | `'idle' \| 'active' \| 'unauthorized'` |
| `useTurnstileStatus()` | `'idle' \| 'pending' \| 'solved' \| 'spent' \| 'expired' \| 'error'` |
| `useTurnstileToken()` | the unspent token, or `null` |

All four return `Readonly<Ref<T>>`. Plus `MitaTurnstile`, which emits `verified`, `expired`
and `error`.

## Notes

- This package is a binding layer only. It deliberately does not re-export
  `@mita-auth/client`'s surface, so `createProtectedClient` is imported from there.
- `<MitaTurnstile>` is built with a render function, so the custom element tag never reaches
  Vue's template compiler and **no `compilerOptions.isCustomElement` is needed**. Writing
  `<mita-turnstile>` directly in your own template still would; using this component is the
  way around it.

## License

MIT
