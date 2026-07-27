import { useStore } from '@nanostores/vue';
import type { Ref } from 'vue';
import type { SessionStatus, TurnstileStatus } from '@mita-auth/client';
import {
  $hasProvenKey,
  $sessionStatus,
  $turnstileStatus,
  $turnstileToken,
} from '@mita-auth/client';

/**
 * These hand back a `ref`, not a value — templates unwrap it, scripts read `.value`.
 *
 * Two caveats come from `@nanostores/vue` rather than from here: the subscription is only
 * set up in a browser, so a server render reads the store once and never updates; and the
 * automatic teardown hangs off `getCurrentScope()`, so calling one of these outside a
 * component's `setup()` leaks the subscription.
 *
 * One composable per store, so a component that watches the widget is not woken by every
 * session change.
 */
/**
 * Whether the server has accepted a proof from this browser's key pair.
 *
 * **Not a sign-in check.** Any visitor gets a key pair on their first request and turns this
 * `true`, so it cannot gate anything that only some people should see.
 */
export function useHasProvenKey(): Readonly<Ref<boolean>> {
  return useStore($hasProvenKey);
}

export function useSessionStatus(): Readonly<Ref<SessionStatus>> {
  return useStore($sessionStatus);
}

export function useTurnstileStatus(): Readonly<Ref<TurnstileStatus>> {
  return useStore($turnstileStatus);
}

export function useTurnstileToken(): Readonly<Ref<string | null>> {
  return useStore($turnstileToken);
}
