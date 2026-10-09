import { APIError } from 'better-auth/api';

/**
 * Better Auth state-changing routes reuse the application's double-submit
 * CSRF pair: the `x-csrf-token` header must match the `pertexo_csrf` cookie.
 */
export function requireDoubleSubmitCsrf(headers: Headers | undefined): void {
  const supplied = headers?.get('x-csrf-token');
  const cookie = headers?.get('cookie');
  const expected = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('pertexo_csrf='))
    ?.slice('pertexo_csrf='.length);
  if (
    supplied === null ||
    supplied === undefined ||
    expected === undefined ||
    supplied.length < 32 ||
    supplied !== decodeURIComponent(expected)
  )
    throw new APIError('FORBIDDEN', {
      code: 'CSRF_TOKEN_INVALID',
      message: 'The request could not be verified.',
    });
}
