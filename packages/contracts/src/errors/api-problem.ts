import { z } from 'zod';

export const API_PROBLEM_CODES = [
  'auth.unauthenticated',
  'auth.forbidden',
  'resource.not_found',
  'request.invalid',
  'request.precondition_required',
  'request.idempotency_conflict',
  'request.rate_limited',
  'request.rate_limit_unavailable',
  'workspace.quota_exceeded',
  'artifact.conflict',
  'artifact.unavailable',
  'workspace.conflict',
  'workflow.revision_conflict',
  'workflow.lifecycle_conflict',
  'workflow.invalid',
  'workflow.not_published',
  'workflow.activation_failed',
  'run.not_cancelable',
  'run.outcome_unknown',
  'connection.conflict',
  'connection.reauthorization_required',
  'connection.revoked',
  'provider.rate_limited',
  'provider.unavailable',
  'platform.write_paused',
  'webhook.authentication_failed',
  'webhook.payload_too_large',
  'webhook.unsupported_media_type',
  'webhook.invalid_json',
  'webhook.idempotency_conflict',
  'webhook.rate_limited',
  'webhook.unavailable',
  'internal.unexpected',
] as const;

export const apiProblemCodeSchema = z.enum(API_PROBLEM_CODES);

export const apiProblemIssueSchema = z
  .object({
    path: z.string().max(1_024),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(500),
  })
  .strict()
  .readonly();

export const apiProblemShape = {
  type: z.string().min(1).max(256),
  title: z.string().min(1).max(256),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1).max(2_000).optional(),
  instance: z.string().min(1).max(2_048).optional(),
  code: apiProblemCodeSchema,
  requestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  errors: z.array(apiProblemIssueSchema).max(100).readonly().optional(),
} satisfies z.ZodRawShape;

export function createApiProblemSchema<Extension extends z.ZodRawShape>(
  extension: Extension,
) {
  return z
    .object({ ...apiProblemShape, ...extension })
    .strict()
    .readonly();
}

export const apiProblemSchema = createApiProblemSchema({});

export type ApiProblemCode = z.output<typeof apiProblemCodeSchema>;
export type ApiProblemIssue = z.output<typeof apiProblemIssueSchema>;
export type ApiProblem = z.output<typeof apiProblemSchema>;
const apiProblemDetails = {
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
  'request.rate_limit_unavailable': {
    status: 503,
    title: 'Request rate limiter unavailable',
    severity: 'error',
    exposeDetail: false,
  },
  'workspace.quota_exceeded': {
    status: 429,
    title: 'Workspace quota exceeded',
    severity: 'warn',
    exposeDetail: true,
  },
  'artifact.conflict': {
    status: 409,
    title: 'Artifact conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'artifact.unavailable': {
    status: 503,
    title: 'Artifact storage unavailable',
    severity: 'warn',
    exposeDetail: false,
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
  'workflow.lifecycle_conflict': {
    status: 409,
    title: 'Workflow lifecycle conflict',
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

export const API_PROBLEM_MANIFEST = Object.freeze(
  Object.fromEntries(
    Object.entries(apiProblemDetails).map(([code, entry]) => [
      code,
      Object.freeze({
        ...entry,
        type: `urn:pertexo:problem:${code}`,
      }),
    ]),
  ),
) as Readonly<{
  [Code in ApiProblemCode]: (typeof apiProblemDetails)[Code] &
    Readonly<{ type: `urn:pertexo:problem:${Code}` }>;
}>;

export type ApiProblemManifestEntry =
  (typeof API_PROBLEM_MANIFEST)[ApiProblemCode];
