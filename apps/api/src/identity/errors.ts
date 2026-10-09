export type IdentityErrorCode =
  | 'identity.email_unverified'
  | 'identity.session_invalid'
  | 'identity.csrf_failed'
  | 'identity.session_not_fresh';

const SAFE_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  'identity.email_unverified': 'The signed-in email is not verified.',
  'identity.session_invalid': 'The session is invalid.',
  'identity.csrf_failed': 'The request could not be verified.',
  'identity.session_not_fresh': 'Sign in again to continue.',
};

/** A mapping-ready error whose message never contains credential or provider data. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError;
}
