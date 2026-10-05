/** Authentication problem presentation and disclosure policy. */
export const authProblems = {
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
  'auth.email_not_verified': {
    status: 403,
    title: 'Email verification required',
    severity: 'info',
    exposeDetail: false,
  },
  'auth.reset_link_invalid': {
    status: 400,
    title: 'Reset link invalid or expired',
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
