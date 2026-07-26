/**
 * The parts of ky a caller cannot do without.
 *
 * `createProtectedClient` returns a `KyInstance`, and ky reports a rejected request by
 * throwing — so telling "the server answered 403" apart from "the request never left the
 * browser", and reading the body the guard sent with its refusal, both go through ky's type
 * guards. Leaving them out made ky a second package every consumer had to install and keep
 * in version step, for the sake of writing an error handler.
 *
 * Only what that needs is re-exported. Anything further is ky's own API, and importing ky
 * directly is the honest way to reach it.
 */
export {
  HTTPError,
  NetworkError,
  TimeoutError,
  isHTTPError,
  isNetworkError,
  isTimeoutError,
  type KyInstance,
  type KyRequest,
  type KyResponse,
} from 'ky';
