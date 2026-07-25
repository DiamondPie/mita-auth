'use client';

import { useStore } from '@nanostores/react';
import type { SessionStatus, TurnstileStatus } from '@mita-auth/client';
import { $isAuthenticated, $sessionStatus, $turnstileStatus, $turnstileToken } from '@mita-auth/client';

export function useIsAuthenticated(): boolean {
  return useStore($isAuthenticated);
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
