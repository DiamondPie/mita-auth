import { describe, expect, it } from 'vitest';

import {
  DPOP_ERROR_CODES,
  DPoPVerificationError,
  MitaError,
  isDPoPVerificationError,
  isMitaError,
} from './errors';

describe('MitaError', () => {
  it('carries the code and preserves the cause', () => {
    const cause = new Error('underlying');
    const error = new MitaError('config.invalid_url', 'bad url', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('config.invalid_url');
    expect(error.message).toBe('bad url');
    expect(error.name).toBe('MitaError');
    expect(error.cause).toBe(cause);
  });
});

describe('DPoPVerificationError', () => {
  it('is a MitaError with its own name', () => {
    const error = new DPoPVerificationError('dpop.expired', 'too old');

    expect(error).toBeInstanceOf(MitaError);
    expect(error.name).toBe('DPoPVerificationError');
    expect(error.code).toBe('dpop.expired');
  });

  it('declares every code under the dpop namespace exactly once', () => {
    expect(new Set(DPOP_ERROR_CODES).size).toBe(DPOP_ERROR_CODES.length);

    for (const code of DPOP_ERROR_CODES) {
      expect(code.startsWith('dpop.')).toBe(true);
    }
  });
});

describe('type guards', () => {
  it('recognises Mita errors', () => {
    expect(isMitaError(new MitaError('config.invalid_url', 'x'))).toBe(true);
    expect(isMitaError(new DPoPVerificationError('dpop.expired', 'x'))).toBe(true);
    expect(isMitaError(new Error('x'))).toBe(false);
    expect(isMitaError('not an error')).toBe(false);
  });

  it('narrows DPoP verification failures specifically', () => {
    expect(isDPoPVerificationError(new DPoPVerificationError('dpop.expired', 'x'))).toBe(true);
    expect(isDPoPVerificationError(new MitaError('config.invalid_url', 'x'))).toBe(false);
    expect(isDPoPVerificationError(undefined)).toBe(false);
  });
});
