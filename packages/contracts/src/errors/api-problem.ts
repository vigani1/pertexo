import { CALLBACK_PROBLEM_CODES, callbackProblems } from './callbacks.js';
import { collaborationProblems } from './workflows/collaboration.js';
import { promotionProblems } from './workflows/promotion.js';
import { publicationReviewProblems } from './workflows/publication-review.js';
import { stepSampleProblems } from './step-samples.js';
import { notificationProblems } from './notifications.js';
import { variableProblems } from './variables.js';
import { formProblems } from './forms.js';
import { pendingTaskProblems } from './pending-tasks.js';
import { workflowErrorProblems } from './workflows/error-policy.js';
import { z } from 'zod';
import {
  WORKFLOW_PORTABILITY_PROBLEM_CODES,
  WORKFLOW_PORTABILITY_PROBLEM_DETAILS,
} from './workflows/portability.js';
import {
  checkedStartProblems,
  workflowInputCaseProblems,
} from './workflows/input-cases.js';
import {
  WORKFLOW_ORGANIZATION_PROBLEM_CODES,
  workflowOrganizationProblems,
} from './workflows/organization.js';
import { workflowConcurrencyProblems } from './workflows/concurrency.js';

export const API_PROBLEM_CODES = [
  ...CALLBACK_PROBLEM_CODES,
  'api_token.unavailable',
  'api_token.limit',
  'auth.unauthenticated',
  'auth.forbidden',
  'auth.email_not_verified',
  'auth.sso_required',
  'auth.two_factor_locked',
  'auth.method_limit',
  'auth.recovery_required',
  'auth.organization_email_managed',
  'auth.alternative_required',
  'auth.reset_link_invalid',
  'auth.conflict',
  'auth.session_not_fresh',
  'resource.not_found',
  'request.invalid',
  'request.precondition_required',
  'request.idempotency_conflict',
  'request.rate_limited',
  'request.rate_limit_unavailable',
  'workspace.quota_exceeded',
  'artifact.too_large',
  'artifact.conflict',
  'artifact.unavailable',
  'workspace.conflict',
  'workspace.revision_conflict',
  'workspace.member_role_revision_conflict',
  'workspace.member_role_transition_conflict',
  'workspace.member_removal_conflict',
  'workspace.member_directory_managed',
  'workspace.member_status_conflict',
  'workspace.invitation_conflict',
  'workspace.invitation_proof_expired',
  'workspace.invitation_revision_conflict',
  'workspace.invitation_recipient_mismatch',
  'workspace.invitation_unavailable',
  'workspace.invitation_delivery_unavailable',
  'workspace.invitation_not_configured',
  'user.profile_revision_conflict',
  'workflow.revision_conflict',
  'workflow.lifecycle_conflict',
  'workflow.name_conflict',
  'workflow.pause_conflict',
  'workflow.auto_pause_settings_conflict',
  'workflow.already_running',
  'workflow.concurrency_revision_conflict',
  'workflow.concurrency_limit_exceeded',
  'workflow.concurrency_limit_unavailable',
  'workflow.publish_approval_required',
  'workflow.publication_review_conflict',
  'workflow.promotion_conflict',
  'workflow.promotion_unavailable',
  'workflow.collaboration_conflict',
  'workflow.error_policy_conflict',
  'workflow.error_target_unavailable',
  'pending_task.already_resolved',
  'pending_task.expired',
  'pending_task.run_closed',
  'pending_task.self_decision',
  'pending_task.not_eligible',
  'notifications.changed',
  'notifications.unavailable',
  'notifications.unsubscribe_unavailable',
  'variables.changed',
  'variables.usage_changed',
  'workflow.variable_snapshot_unavailable',
  'trigger.coordination_unavailable',
  'form.unavailable',
  'form.changed',
  'form.access_conflict',
  'form.invalid',
  'form.file_type_not_allowed',
  'form.file_too_large',
  'form.upload_limit',
  'form.upload_busy',
  'form.required',

  'workflow.sample_conflict',
  'workflow.sample_invalid',
  'workflow.sample_limit',
  'workflow.input_case_revision_conflict',
  'workflow.input_case_limit_exceeded',
  ...WORKFLOW_ORGANIZATION_PROBLEM_CODES,
  'workspace.auto_pause_settings_conflict',
  'workflow.invalid',
  ...WORKFLOW_PORTABILITY_PROBLEM_CODES,
  'workflow.template_origin_unavailable',
  'workflow.validation_unavailable',
  'workflow.published_version_conflict',
  'workflow.not_published',
  'workflow.activation_failed',
  'run.not_cancelable',
  'run.outcome_unknown',
  'run.recovery_unavailable',
  'connection.not_configured',
  'webhook.not_configured',
  'connection.conflict',
  'connection.revoked',
  'provider.unavailable',
  'webhook.authentication_failed',
  'webhook.payload_too_large',
  'webhook.unsupported_media_type',
  'webhook.invalid_json',
  'webhook.method_not_allowed',
  'webhook.idempotency_conflict',
  'webhook.rate_limited',
  'webhook.workflow_paused',
  'webhook.unavailable',
  'request.aborted',
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
  ...callbackProblems,
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
  'artifact.too_large': {
    status: 413,
    title: 'File too large',
    severity: 'info',
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
    exposeDetail: true,
  },
  'workspace.conflict': {
    status: 409,
    title: 'Workspace conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'workspace.revision_conflict': {
    status: 412,
    title: 'Workspace revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.member_role_revision_conflict': {
    status: 409,
    title: 'Workspace member role changed',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.member_role_transition_conflict': {
    status: 409,
    title: 'Workspace member role transition conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.member_removal_conflict': {
    status: 409,
    title: 'Workspace member removal conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.member_directory_managed': {
    status: 409,
    title: 'Membership managed by organization directory',
    severity: 'info',
    exposeDetail: true,
  },
  'workspace.member_status_conflict': {
    status: 409,
    title: 'Workspace member status conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.invitation_conflict': {
    status: 409,
    title: 'Workspace invitation conflict',
    severity: 'info',
    exposeDetail: true,
  },
  'workspace.invitation_proof_expired': {
    status: 409,
    title: 'Invitation verification expired',
    severity: 'info',
    exposeDetail: true,
  },
  'workspace.invitation_revision_conflict': {
    status: 409,
    title: 'Workspace invitation changed',
    severity: 'warn',
    exposeDetail: true,
  },
  'workspace.invitation_recipient_mismatch': {
    status: 409,
    title: 'Invitation recipient does not match',
    severity: 'info',
    exposeDetail: true,
  },
  'workspace.invitation_unavailable': {
    status: 404,
    title: 'Workspace invitation unavailable',
    severity: 'info',
    exposeDetail: false,
  },
  'workspace.invitation_delivery_unavailable': {
    status: 503,
    title: 'Invitation delivery unavailable',
    severity: 'error',
    exposeDetail: true,
  },
  'workspace.invitation_not_configured': {
    status: 503,
    title: 'Invitations are not configured',
    severity: 'warn',
    exposeDetail: false,
  },
  'user.profile_revision_conflict': {
    status: 412,
    title: 'Profile revision conflict',
    severity: 'warn',
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
  'workflow.name_conflict': {
    status: 409,
    title: 'Workflow name conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.pause_conflict': {
    status: 409,
    title: 'Workflow pause conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.auto_pause_settings_conflict': {
    status: 409,
    title: 'Workflow auto-pause settings conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  ...workflowConcurrencyProblems,
  ...publicationReviewProblems,
  ...promotionProblems,
  ...collaborationProblems,
  ...workflowErrorProblems,
  ...pendingTaskProblems,
  ...notificationProblems,
  ...variableProblems,
  'trigger.coordination_unavailable': {
    status: 503,
    title: 'Event coordination temporarily unavailable',
    severity: 'warn',
    exposeDetail: false,
  },
  ...formProblems,
  ...stepSampleProblems,
  ...workflowInputCaseProblems,
  ...workflowOrganizationProblems,
  'workspace.auto_pause_settings_conflict': {
    status: 409,
    title: 'Workspace auto-pause settings conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.invalid': {
    status: 422,
    title: 'Invalid workflow',
    severity: 'info',
    exposeDetail: true,
  },
  ...WORKFLOW_PORTABILITY_PROBLEM_DETAILS,
  'workflow.validation_unavailable': {
    status: 503,
    title: 'Workflow validation unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
  ...checkedStartProblems,
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
  'run.recovery_unavailable': {
    status: 409,
    title: 'Recovery unavailable',
    severity: 'info',
    exposeDetail: true,
  },
  'connection.not_configured': {
    status: 503,
    title: 'Connections are not configured',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.not_configured': {
    status: 503,
    title: 'Webhooks are not configured',
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
  'provider.unavailable': {
    status: 503,
    title: 'Provider unavailable',
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
  'webhook.method_not_allowed': {
    status: 405,
    title: 'Webhook method not allowed',
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
  // ADR 056: returned only after the signature verified.
  'webhook.workflow_paused': {
    status: 423,
    title: 'Workflow paused',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.unavailable': {
    status: 503,
    title: 'Webhook unavailable',
    severity: 'error',
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
} as const satisfies Record<
  ApiProblemCode,
  Readonly<{
    status: number;
    title: string;
    severity: 'error' | 'info' | 'warn';
    exposeDetail: boolean;
  }>
>;

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
