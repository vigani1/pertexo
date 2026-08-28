import type { ApiProblemCode } from '@pertexo/contracts/errors';

export const APPLICATION_ERROR_CATALOG = {
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
  'workspace.quota_exceeded': {
    status: 429,
    title: 'Workspace quota exceeded',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.conflict': {
    status: 409,
    title: 'Workspace conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.revision_conflict': {
    status: 412,
    title: 'Workflow revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.invalid': {
    status: 422,
    title: 'Invalid workflow',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.not_published': {
    status: 409,
    title: 'Workflow not published',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.activation_failed': {
    status: 409,
    title: 'Workflow activation failed',
    severity: 'warn',
    exposeDetail: true,
  },
  'run.not_cancelable': {
    status: 409,
    title: 'Run cannot be canceled',
    severity: 'info',
    exposeDetail: true,
  },
  'run.outcome_unknown': {
    status: 409,
    title: 'Run outcome is unknown',
    severity: 'warn',
    exposeDetail: true,
  },
  'connection.conflict': {
    status: 409,
    title: 'Connection conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'connection.reauthorization_required': {
    status: 401,
    title: 'Connection reauthorization required',
    severity: 'info',
    exposeDetail: false,
  },
  'connection.revoked': {
    status: 409,
    title: 'Connection unavailable',
    severity: 'info',
    exposeDetail: true,
  },
  'provider.rate_limited': {
    status: 429,
    title: 'Provider rate limit reached',
    severity: 'warn',
    exposeDetail: true,
  },
  'provider.unavailable': {
    status: 503,
    title: 'Provider unavailable',
    severity: 'error',
    exposeDetail: true,
  },
  'platform.write_paused': {
    status: 503,
    title: 'Durable writes temporarily paused',
    severity: 'error',
    exposeDetail: true,
  },
  'webhook.authentication_failed': {
    status: 401,
    title: 'Webhook authentication failed',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.payload_too_large': {
    status: 413,
    title: 'Webhook payload too large',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.unsupported_media_type': {
    status: 415,
    title: 'Unsupported webhook media type',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.invalid_json': {
    status: 400,
    title: 'Invalid webhook JSON',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.idempotency_conflict': {
    status: 409,
    title: 'Webhook idempotency conflict',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.rate_limited': {
    status: 429,
    title: 'Webhook rate limit reached',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.unavailable': {
    status: 503,
    title: 'Webhook unavailable',
    severity: 'error',
    exposeDetail: false,
  },
  'internal.unexpected': {
    status: 500,
    title: 'Internal server error',
    severity: 'error',
    exposeDetail: false,
  },
} as const satisfies Record<
  ApiProblemCode,
  Readonly<{
    status: number;
    title: string;
    severity: 'error' | 'info' | 'warn';
    exposeDetail: boolean;
  }>
>;

export type ApplicationErrorCode = ApiProblemCode;
export type ApplicationErrorCatalogEntry =
  (typeof APPLICATION_ERROR_CATALOG)[ApplicationErrorCode];

export type ApplicationError = Readonly<{
  code: ApplicationErrorCode;
  safeDetail?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}>;

type ApplicationErrorOptions = Readonly<{
  safeDetail?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}>;

export function applicationError(
  code: ApplicationErrorCode,
  options: ApplicationErrorOptions = {},
): ApplicationError {
  const safeDetail = options.safeDetail;
  if (safeDetail !== undefined && safeDetail.length > 2_000) {
    throw new RangeError('safe application error detail is too long');
  }

  return Object.freeze({
    code,
    ...(safeDetail === undefined ? {} : { safeDetail }),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function isApplicationError(value: unknown): value is ApplicationError {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return false;
  }

  const code = value.code;
  return typeof code === 'string' && code in APPLICATION_ERROR_CATALOG;
}
