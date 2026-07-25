import { act, cleanup, render, screen } from '@testing-library/react';
import {
  markSessionActive,
  markSessionUnauthorized,
  resetMitaState,
  setTurnstileToken,
} from '@mita-auth/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useIsAuthenticated,
  useSessionStatus,
  useTurnstileStatus,
  useTurnstileToken,
} from './hooks';

function Probe(): React.JSX.Element {
  return (
    <ul>
      <li data-testid="isAuthenticated">{String(useIsAuthenticated())}</li>
      <li data-testid="sessionStatus">{useSessionStatus()}</li>
      <li data-testid="turnstileStatus">{useTurnstileStatus()}</li>
      <li data-testid="turnstileToken">{useTurnstileToken() ?? 'none'}</li>
    </ul>
  );
}

function read(): Record<string, string | null> {
  return {
    isAuthenticated: screen.getByTestId('isAuthenticated').textContent,
    sessionStatus: screen.getByTestId('sessionStatus').textContent,
    turnstileStatus: screen.getByTestId('turnstileStatus').textContent,
    turnstileToken: screen.getByTestId('turnstileToken').textContent,
  };
}

// Vitest is not running with `globals: true`, so Testing Library never finds an `afterEach`
// to hang its own cleanup on.
afterEach(cleanup);

describe('hooks', () => {
  beforeEach(() => {
    resetMitaState();
  });

  it('renders the initial value of every store', () => {
    render(<Probe />);

    expect(read()).toEqual({
      isAuthenticated: 'false',
      sessionStatus: 'idle',
      turnstileStatus: 'idle',
      turnstileToken: 'none',
    });
  });

  it('re-renders once the server accepts a proof', () => {
    render(<Probe />);

    act(() => {
      markSessionActive();
    });

    expect(read()).toMatchObject({ isAuthenticated: 'true', sessionStatus: 'active' });
  });

  it('re-renders once the server rejects a proof', () => {
    render(<Probe />);

    act(() => {
      markSessionActive();
      markSessionUnauthorized();
    });

    expect(read()).toMatchObject({ isAuthenticated: 'false', sessionStatus: 'unauthorized' });
  });

  it('re-renders with the token the visitor earned', () => {
    render(<Probe />);

    act(() => {
      setTurnstileToken('token-1');
    });

    expect(read()).toMatchObject({ turnstileStatus: 'solved', turnstileToken: 'token-1' });
  });

  it('falls back to the initial values once the state is reset', () => {
    render(<Probe />);

    act(() => {
      markSessionActive();
      setTurnstileToken('token-1');
      resetMitaState();
    });

    expect(read()).toEqual({
      isAuthenticated: 'false',
      sessionStatus: 'idle',
      turnstileStatus: 'idle',
      turnstileToken: 'none',
    });
  });

  // One hook per store exists for this: a component that only cares about the widget
  // should not repaint every time the session moves.
  it('leaves a component subscribed to another store alone', () => {
    const rendered = vi.fn();

    function TurnstileOnly(): React.JSX.Element {
      rendered();
      return <span>{useTurnstileStatus()}</span>;
    }

    render(<TurnstileOnly />);
    const before = rendered.mock.calls.length;

    act(() => {
      markSessionActive();
    });

    expect(rendered.mock.calls).toHaveLength(before);
  });
});
