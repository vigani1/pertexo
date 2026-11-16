import { connectionsProblems } from './connections.js';
import { runsProblems } from './runs.js';
import { workflowsLifecycleProblems } from './workflows/lifecycle.js';
import { webhooksProblems } from './webhooks.js';
import { dataTablesProblems } from './data-tables.js';
import { artifactsProblems } from './artifacts.js';
import { workspacesProblems } from './workspaces.js';
import { requestProblems } from './request.js';
import { authProblems } from './auth.js';
import { responseSchema } from '../schemas/shared/response-schema.js';
import { callbackProblems } from './callbacks.js';
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
import { WORKFLOW_PORTABILITY_PROBLEM_DETAILS } from './workflows/portability.js';
import {
  checkedStartProblems,
  workflowInputCaseProblems,
} from './workflows/input-cases.js';
import { workflowOrganizationProblems } from './workflows/organization.js';
import { workflowConcurrencyProblems } from './workflows/concurrency.js';

const API_PROBLEM_BOUNDS = Object.freeze({
  pathCharacters: 1024,
  codeCharacters: 128,
  messageCharacters: 500,
  typeCharacters: 256,
  titleCharacters: 256,
  detailCharacters: 2000,
  instanceCharacters: 2048,
  requestIdCharacters: 128,
  errorsItems: 100,
});

const apiProblemDetails = {
  ...callbackProblems,
  'api_token.unavailable': authProblems['api_token.unavailable'],
  'api_token.limit': authProblems['api_token.limit'],
  'auth.unauthenticated': authProblems['auth.unauthenticated'],
  'auth.forbidden': authProblems['auth.forbidden'],
  'auth.token_scope_required': authProblems['auth.token_scope_required'],
  'auth.token_not_supported': authProblems['auth.token_not_supported'],
  'auth.email_not_verified': authProblems['auth.email_not_verified'],
  'auth.sso_required': authProblems['auth.sso_required'],
  'auth.two_factor_locked': authProblems['auth.two_factor_locked'],
  'auth.invalid_credentials': authProblems['auth.invalid_credentials'],
  'auth.two_factor_code_invalid': authProblems['auth.two_factor_code_invalid'],
  'auth.two_factor_challenge_expired':
    authProblems['auth.two_factor_challenge_expired'],
  'auth.invalid_password': authProblems['auth.invalid_password'],
  'auth.password_already_configured':
    authProblems['auth.password_already_configured'],
  'auth.authentication_changed': authProblems['auth.authentication_changed'],
  'auth.last_method': authProblems['auth.last_method'],
  'auth.method_limit': authProblems['auth.method_limit'],
  'auth.recovery_required': authProblems['auth.recovery_required'],
  'auth.organization_email_managed':
    authProblems['auth.organization_email_managed'],
  'auth.alternative_required': authProblems['auth.alternative_required'],
  'auth.reset_link_invalid': authProblems['auth.reset_link_invalid'],
  'auth.sign_up_closed': authProblems['auth.sign_up_closed'],
  'auth.conflict': authProblems['auth.conflict'],
  'auth.session_not_fresh': authProblems['auth.session_not_fresh'],
  'resource.not_found': requestProblems['resource.not_found'],
  'request.invalid': requestProblems['request.invalid'],
  'request.precondition_required':
    requestProblems['request.precondition_required'],
  'request.idempotency_conflict':
    requestProblems['request.idempotency_conflict'],
  'request.rate_limited': requestProblems['request.rate_limited'],
  'request.rate_limit_unavailable':
    requestProblems['request.rate_limit_unavailable'],
  'request.method_not_allowed': requestProblems['request.method_not_allowed'],
  'request.too_large': requestProblems['request.too_large'],
  'request.unsupported_media_type':
    requestProblems['request.unsupported_media_type'],
  'workspace.quota_exceeded': workspacesProblems['workspace.quota_exceeded'],
  'artifact.too_large': artifactsProblems['artifact.too_large'],
  'artifact.upload_unavailable':
    artifactsProblems['artifact.upload_unavailable'],
  'artifact.conflict': artifactsProblems['artifact.conflict'],
  'artifact.unavailable': artifactsProblems['artifact.unavailable'],
  'workspace.conflict': workspacesProblems['workspace.conflict'],
  'data_table.stored_definition_invalid':
    dataTablesProblems['data_table.stored_definition_invalid'],
  'data_table.conflict': dataTablesProblems['data_table.conflict'],
  'data_table.key_conflict': dataTablesProblems['data_table.key_conflict'],
  'data_table.quota_exceeded': dataTablesProblems['data_table.quota_exceeded'],
  'export.already_running': dataTablesProblems['export.already_running'],
  'webhook.setting_up': webhooksProblems['webhook.setting_up'],
  'workspace.revision_conflict':
    workspacesProblems['workspace.revision_conflict'],
  'workspace.member_role_revision_conflict':
    workspacesProblems['workspace.member_role_revision_conflict'],
  'workspace.member_role_transition_conflict':
    workspacesProblems['workspace.member_role_transition_conflict'],
  'workspace.member_removal_conflict':
    workspacesProblems['workspace.member_removal_conflict'],
  'workspace.member_directory_managed':
    workspacesProblems['workspace.member_directory_managed'],
  'workspace.member_status_conflict':
    workspacesProblems['workspace.member_status_conflict'],
  'workspace.recovery_owner_ineligible':
    workspacesProblems['workspace.recovery_owner_ineligible'],
  'workspace.invitation_conflict':
    workspacesProblems['workspace.invitation_conflict'],
  'workspace.invitation_proof_expired':
    workspacesProblems['workspace.invitation_proof_expired'],
  'workspace.invitation_revision_conflict':
    workspacesProblems['workspace.invitation_revision_conflict'],
  'workspace.invitation_recipient_mismatch':
    workspacesProblems['workspace.invitation_recipient_mismatch'],
  'workspace.invitation_unavailable':
    workspacesProblems['workspace.invitation_unavailable'],
  'workspace.invitation_delivery_unavailable':
    workspacesProblems['workspace.invitation_delivery_unavailable'],
  'workspace.invitation_not_configured':
    workspacesProblems['workspace.invitation_not_configured'],
  'user.profile_revision_conflict':
    workspacesProblems['user.profile_revision_conflict'],
  'workflow.revision_conflict':
    workflowsLifecycleProblems['workflow.revision_conflict'],
  'workflow.lifecycle_conflict':
    workflowsLifecycleProblems['workflow.lifecycle_conflict'],
  'workflow.name_conflict':
    workflowsLifecycleProblems['workflow.name_conflict'],
  'workflow.pause_conflict':
    workflowsLifecycleProblems['workflow.pause_conflict'],
  'workflow.auto_pause_settings_conflict':
    workflowsLifecycleProblems['workflow.auto_pause_settings_conflict'],
  ...workflowConcurrencyProblems,
  ...publicationReviewProblems,
  ...promotionProblems,
  ...collaborationProblems,
  ...workflowErrorProblems,
  ...pendingTaskProblems,
  ...notificationProblems,
  ...variableProblems,
  'trigger.coordination_unavailable':
    webhooksProblems['trigger.coordination_unavailable'],
  ...formProblems,
  ...stepSampleProblems,
  ...workflowInputCaseProblems,
  ...workflowOrganizationProblems,
  'workspace.auto_pause_settings_conflict':
    workspacesProblems['workspace.auto_pause_settings_conflict'],
  'workflow.invalid': workflowsLifecycleProblems['workflow.invalid'],
  ...WORKFLOW_PORTABILITY_PROBLEM_DETAILS,
  'workflow.validation_unavailable':
    workflowsLifecycleProblems['workflow.validation_unavailable'],
  ...checkedStartProblems,
  'workflow.not_published':
    workflowsLifecycleProblems['workflow.not_published'],
  'workflow.activation_failed':
    workflowsLifecycleProblems['workflow.activation_failed'],
  'run.not_cancelable': runsProblems['run.not_cancelable'],
  'run.outcome_unknown': runsProblems['run.outcome_unknown'],
  'run.recovery_unavailable': runsProblems['run.recovery_unavailable'],
  'connection.not_configured': connectionsProblems['connection.not_configured'],
  'webhook.not_configured': webhooksProblems['webhook.not_configured'],
  'connection.conflict': connectionsProblems['connection.conflict'],
  'connection.revoked': connectionsProblems['connection.revoked'],
  'connection.oauth2_endpoint_refused':
    connectionsProblems['connection.oauth2_endpoint_refused'],
  'connection.oauth2_token_refused':
    connectionsProblems['connection.oauth2_token_refused'],
  'provider.unavailable': connectionsProblems['provider.unavailable'],
  'webhook.authentication_failed':
    webhooksProblems['webhook.authentication_failed'],
  'webhook.payload_too_large': webhooksProblems['webhook.payload_too_large'],
  'webhook.unsupported_media_type':
    webhooksProblems['webhook.unsupported_media_type'],
  'webhook.invalid_json': webhooksProblems['webhook.invalid_json'],
  'webhook.method_not_allowed': webhooksProblems['webhook.method_not_allowed'],
  'webhook.idempotency_conflict':
    webhooksProblems['webhook.idempotency_conflict'],
  'webhook.rate_limited': webhooksProblems['webhook.rate_limited'],
  'webhook.workflow_paused': webhooksProblems['webhook.workflow_paused'],
  'webhook.unavailable': webhooksProblems['webhook.unavailable'],
  'request.temporarily_unavailable':
    requestProblems['request.temporarily_unavailable'],
  'request.aborted': requestProblems['request.aborted'],
  'internal.unexpected': requestProblems['internal.unexpected'],
} as const satisfies Record<
  string,
  Readonly<{
    status: number;
    title: string;
    severity: 'error' | 'info' | 'warn';
    exposeDetail: boolean;
  }>
>;

// Object.keys preserves registry order; the assertion retains the exact wire-code union.
export const API_PROBLEM_CODES = Object.keys(
  apiProblemDetails,
) as (keyof typeof apiProblemDetails)[];

export const apiProblemCodeSchema = z.enum(API_PROBLEM_CODES);

export const apiProblemIssueSchema = z
  .object({
    path: z.string().max(API_PROBLEM_BOUNDS.pathCharacters),
    code: z.string().min(1).max(API_PROBLEM_BOUNDS.codeCharacters),
    message: z.string().min(1).max(API_PROBLEM_BOUNDS.messageCharacters),
  })
  .strict()
  .readonly();

export const apiProblemShape = {
  type: z.string().min(1).max(API_PROBLEM_BOUNDS.typeCharacters),
  title: z.string().min(1).max(API_PROBLEM_BOUNDS.titleCharacters),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1).max(API_PROBLEM_BOUNDS.detailCharacters).optional(),
  instance: z
    .string()
    .min(1)
    .max(API_PROBLEM_BOUNDS.instanceCharacters)
    .optional(),
  code: apiProblemCodeSchema,
  requestId: z
    .string()
    .min(1)
    .max(API_PROBLEM_BOUNDS.requestIdCharacters)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  errors: z
    .array(apiProblemIssueSchema)
    .max(API_PROBLEM_BOUNDS.errorsItems)
    .readonly()
    .optional(),
} satisfies z.ZodRawShape;

export function createApiProblemSchema<Extension extends z.ZodRawShape>(
  extension: Extension,
) {
  return responseSchema(
    z
      .object({ ...apiProblemShape, ...extension })
      .strict()
      .readonly(),
  );
}

export const apiProblemSchema = createApiProblemSchema({});

export type ApiProblemCode = z.output<typeof apiProblemCodeSchema>;
export type ApiProblemIssue = z.output<typeof apiProblemIssueSchema>;
export type ApiProblem = z.output<typeof apiProblemSchema>;

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
