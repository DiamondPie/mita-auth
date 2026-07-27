/**
 * The two symbols needed to read a failure Mita raised itself.
 *
 * Not every refusal comes back as an HTTP response: a request the timeout budget cannot
 * cover is rejected before it is sent, and `code` is the stable thing to branch on when it
 * happens. Re-exported for the same reason as ky's guards in `./ky` — reading an error
 * should not oblige a browser project to install and version-track `@mita-auth/core`, which
 * it otherwise never names.
 */
export { MitaError, isMitaError } from '@mita-auth/core';
