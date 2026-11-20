export const requestProblems = {
  'resource.not_found': {
    status: 404,
    title: 'Resource not found',
    severity: 'info',
    exposeDetail: false,
  },
  'request.invalid': {
    status: 400,
    title: 'Invalid request',
    severity: 'info',
    exposeDetail: true,
  },
  'request.precondition_required': {
    status: 428,
    title: 'Precondition required',
    severity: 'info',
    exposeDetail: true,
  },
  'request.idempotency_conflict': {
    status: 409,
    title: 'Idempotency conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'request.rate_limited': {
    status: 429,
    title: 'Request rate limit reached',
    severity: 'warn',
    exposeDetail: false,
  },
  'request.rate_limit_unavailable': {
    status: 503,
    title: 'Request rate limiter unavailable',
    severity: 'error',
    exposeDetail: false,
  },
  'request.method_not_allowed': {
    status: 405,
    title: 'Method not allowed',
    severity: 'info',
    exposeDetail: false,
  },
  'request.too_large': {
    status: 413,
    title: 'Request body too large',
    severity: 'info',
    exposeDetail: false,
  },
  'request.unsupported_media_type': {
    status: 415,
    title: 'Unsupported media type',
    severity: 'info',
    exposeDetail: false,
  },
  'request.temporarily_unavailable': {
    status: 503,
    title: 'Service temporarily unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
  // The API holds as many requests as it safely can and turns the rest away.
  'server.busy': {
    status: 503,
    title: 'Server busy',
    severity: 'warn',
    exposeDetail: false,
  },
  'request.aborted': {
    status: 499,
    title: 'Request closed by the client',
    severity: 'info',
    exposeDetail: false,
  },
  'internal.unexpected': {
    status: 500,
    title: 'Internal server error',
    severity: 'error',
    exposeDetail: false,
  },
} as const;
