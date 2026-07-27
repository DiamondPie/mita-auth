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
import { MitaTurnstile, useHasProvenKey, useTurnstileStatus } from '@mita-auth/vue';

const provenKey = useHasProvenKey();
const turnstile = useTurnstileStatus();
</script>

<template>
  <form>
    <!-- … -->
    <MitaTurnstile :site-key="siteKey" @error="(code) => console.warn(code)" />
    <button :disabled="turnstile !== 'solved'">Post</button>
    <span v-if="provenKey">session active</span>
  </form>
</template>
```

## Exports

| Composable | Reads |
| --- | --- |
| `useHasProvenKey()` | whether the server has accepted a proof from this browser's key pair — **not a sign-in check**, see Notes |
| `useSessionStatus()` | `'idle' \| 'active' \| 'unauthorized'` |
| `useTurnstileStatus()` | `'idle' \| 'pending' \| 'solved' \| 'spent' \| 'expired' \| 'error'` |
| `useTurnstileToken()` | the unspent token, or `null` |

All four return `Readonly<Ref<T>>`. Plus `MitaTurnstile`, which emits `verified`, `expired`
and `error`.

## Notes

- **`useHasProvenKey()` is not an identity check.** Mita has no login step: the DPoP exchange
  proves that a request was signed by whoever holds a given private key and that the same key
  signed the ones before it, never who that is. Every visitor gets a key pair on their first
  request, so `useHasProvenKey()` turns `true` for all of them. Use it to show connection
  state; never to gate anything only some people should reach.
- This package is a binding layer only. It deliberately does not re-export
  `@mita-auth/client`'s surface, so `createProtectedClient` is imported from there.
- `<MitaTurnstile>` is built with a render function, so the custom element tag never reaches
  Vue's template compiler and **no `compilerOptions.isCustomElement` is needed**. Writing
  `<mita-turnstile>` directly in your own template still would; using this component is the
  way around it.

## License

MIT
