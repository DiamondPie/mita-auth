/**
 * Side-effecting entry point: importing `@mita-auth/client/turnstile` registers
 * `<mita-turnstile>`.
 *
 * It is kept apart from the main entry so a project that only talks to the API can still
 * be tree-shaken down to the fetch client.
 */
import { defineMitaTurnstile } from './turnstile-element';

export * from './turnstile-element';

defineMitaTurnstile();
