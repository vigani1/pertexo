export const authProblems = {
  'api_token.unavailable': {
    status: 503,
    title: 'Automation tokens unavailable',
    severity: 'info',
    exposeDetail: true,
  },
  'api_token.limit': {
    status: 409,
    title: 'Active token limit reached',
    severity: 'info',
    exposeDetail: true,
  },
  'auth.unauthenticated': {
    status: 401,
    title: 'Authentication required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.forbidden': {
    status: 403,
    title: 'Forbidden',
    severity: 'info',
    exposeDetail: true,
  },
  'auth.token_scope_required': {
    status: 403,
    title: 'Token scope required',
    severity: 'info',
    exposeDetail: true,
  },
  'auth.token_not_supported': {
    status: 403,
    title: 'API tokens are not accepted here',
    severity: 'info',
    exposeDetail: true,
  },
  'auth.email_not_verified': {
    status: 403,
    title: 'Email verification required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.sso_required': {
    status: 403,
    title: 'Organization sign-in required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.two_factor_locked': {
    status: 429,
    title: 'Two-factor sign-in temporarily locked',
    severity: 'info',
    exposeDetail: false,
  },
  // A refused credential while signing in or proving it is you. 400, like
  // auth.invalid_password: a 401 means only an ended session.
  'auth.invalid_credentials': {
    status: 400,
    title: 'Sign-in details not accepted',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.two_factor_code_invalid': {
    status: 400,
    title: 'Two-factor code not accepted',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.two_factor_challenge_expired': {
    status: 400,
    title: 'Two-factor sign-in expired',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.invalid_password': {
    status: 400,
    title: 'The current password is incorrect. Check it and try again.',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.password_already_configured': {
    status: 409,
    title:
      'A password is already configured. Reload security settings and use Change password.',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.authentication_changed': {
    status: 409,
    title:
      'Sign-in settings changed. Sign in again using your current organization policy.',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.last_method': {
    status: 400,
    title: 'Another working sign-in method required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.method_limit': {
    status: 400,
    title: 'Sign-in method limit reached',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.recovery_required': {
    status: 403,
    title: 'Recovery password required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.organization_email_managed': {
    status: 403,
    title: 'Organization email address is managed',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.alternative_required': {
    status: 403,
    title: 'Another sign-in method required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.reset_link_invalid': {
    status: 400,
    title: 'Reset link invalid or expired',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.sign_up_closed': {
    status: 403,
    title: 'Sign-up is by invitation',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.conflict': {
    status: 409,
    title: 'Authentication change conflict',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.session_not_fresh': {
    status: 403,
    title: 'Recent sign-in required',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
