export const connectionsProblems = {
  'connection.not_configured': {
    status: 503,
    title: 'Connections are not configured',
    severity: 'warn',
    exposeDetail: false,
  },
  'connection.conflict': {
    status: 409,
    title: 'Connection conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'connection.revoked': {
    status: 409,
    title: 'Connection unavailable',
    severity: 'info',
    exposeDetail: true,
  },
  'connection.oauth2_endpoint_refused': {
    status: 400,
    title: 'OAuth2 address refused',
    severity: 'info',
    exposeDetail: true,
  },
  'connection.oauth2_token_refused': {
    status: 409,
    title: 'OAuth2 token refused',
    severity: 'info',
    exposeDetail: true,
  },
  'provider.unavailable': {
    status: 503,
    title: 'Provider unavailable',
    severity: 'error',
    exposeDetail: true,
  },
} as const;
