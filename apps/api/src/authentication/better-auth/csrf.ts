import { APIError } from 'better-auth/api';
import { browserCsrfRefusal } from '../../identity/csrf.js';

/** Adapt the shared browser proof refusal to the SDK protocol. */
export function requireDoubleSubmitCsrf(headers: Headers | undefined): void {
  const status = browserCsrfRefusal(headers);
  if (status !== undefined)
    throw new APIError(status === 400 ? 'BAD_REQUEST' : 'FORBIDDEN', {
      code: status === 400 ? 'INVALID_BODY' : 'CSRF_TOKEN_INVALID',
      message: 'The request could not be verified.',
    });
}
