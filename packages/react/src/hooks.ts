'use client';

import { useStore } from '@nanostores/react';
import type { SessionStatus, TurnstileStatus } from '@mita-auth/client';
import { $hasProvenKey, $sessionStatus, $turnstileStatus, $turnstileToken } from '@mita-auth/client';

/**
 * Whether the server has accepted a proof from this browser's key pair.
 *
 * **Not a sign-in check.** Any visitor gets a key pair on their first request and turns this
 * `true`, so it cannot gate anything that only some people should see.
 */
export function useHasProvenKey(): boolean {
  return useStore($hasProvenKey);
}

export function useSessionStatus(): SessionStatus {
  return useStore($sessionStatus);
}

export function useTurnstileStatus(): TurnstileStatus {
  return useStore($turnstileStatus);
}

export function useTurnstileToken(): string | null {
  return useStore($turnstileToken);
}
