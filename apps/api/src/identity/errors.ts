export type IdentityErrorCode =
  | 'identity.invalid_input'
  | 'identity.transaction_missing'
  | 'identity.transaction_expired'
  | 'identity.transaction_replayed'
  | 'identity.callback_rejected'
  | 'identity.provider_rejected'
  | 'identity.provider_unavailable'
  | 'identity.issuer_mismatch'
  | 'identity.audience_mismatch'
  | 'identity.nonce_mismatch'
  | 'identity.subject_missing'
  | 'identity.profile_incomplete'
  | 'identity.mapping_failed'
  | 'identity.session_invalid'
  | 'identity.session_expired'
  | 'identity.session_revoked'
  | 'identity.csrf_failed';

const SAFE_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  'identity.invalid_input': 'The identity request is invalid.',
  'identity.transaction_missing': 'The login transaction is invalid.',
  'identity.transaction_expired': 'The login transaction has expired.',
  'identity.transaction_replayed':
    'The login transaction has already been used.',
  'identity.callback_rejected': 'The identity callback was rejected.',
  'identity.provider_rejected': 'The identity provider rejected the login.',
  'identity.provider_unavailable':
    'The identity provider is temporarily unavailable.',
  'identity.issuer_mismatch':
    'The identity provider is not configured for this application.',
  'identity.audience_mismatch':
    'The identity assertion is not for this application.',
  'identity.nonce_mismatch': 'The identity assertion could not be verified.',
  'identity.subject_missing': 'The identity assertion has no stable subject.',
  'identity.profile_incomplete': 'The identity profile is incomplete.',
  'identity.mapping_failed': 'The external identity could not be mapped.',
  'identity.session_invalid': 'The session is invalid.',
  'identity.session_expired': 'The session has expired.',
  'identity.session_revoked': 'The session has been revoked.',
  'identity.csrf_failed': 'The request could not be verified.',
};

/** A mapping-ready error whose message never contains credential or provider data. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly status: 400 | 401 | 403 | 503;

  constructor(code: IdentityErrorCode, status?: 400 | 401 | 403 | 503) {
    super(SAFE_MESSAGES[code]);
    this.name = 'IdentityError';
    this.code = code;
    this.status = status ?? defaultStatus(code);
  }
}

function defaultStatus(code: IdentityErrorCode): 400 | 401 | 403 | 503 {
  if (code === 'identity.csrf_failed') return 403;
  if (code === 'identity.provider_unavailable') return 503;
  if (
    code === 'identity.session_invalid' ||
    code === 'identity.session_expired' ||
    code === 'identity.session_revoked'
  ) {
    return 401;
  }
  return 400;
}

export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError;
}
