import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';

import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as autoPause from '../../schemas/workflows/auto-pause.js';
import * as concurrency from '../../schemas/workflows/concurrency.js';
import * as errorWorkflow from '../../schemas/workflows/error.js';
import { defineRoute } from '../define.js';
import {
  conflictOf,
  problems,
  projected,
  publishing,
  readProblems,
  reading,
  session,
  updating,
  WORKFLOW,
  workspaceParams,
} from './access.js';

const noStore = 'private, no-store';
const autoPauseCommand = projected(
  'WorkflowAutoPauseCommandResponse',
  autoPause.workflowAutoPauseCommandResponseSchema,
);
const replayed =
  'Command accepted; exact retries replay the original settings snapshot';

export const workflowSettingsRoutes = {
  concurrency: defineRoute({
    operationId: 'getWorkflowConcurrencySettings',
    method: 'get',
    path: `${WORKFLOW}/concurrency`,
    params: workflowIdParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    description:
      'Read current operational concurrency policy. Requires workflow:read and active workspace. No-store snapshot; null adds no workflow cap, not unlimited workspace capacity.',
    success: {
      status: 200,
      description: 'Current workflow concurrency snapshot',
      body: projected(
        'WorkflowConcurrencySettings',
        concurrency.workflowConcurrencySettingsSchema,
      ),
    },
    problems: readProblems,
  }),
  updateConcurrency: defineRoute({
    operationId: 'updateWorkflowConcurrencySettings',
    method: 'put',
    path: `${WORKFLOW}/concurrency`,
    params: workflowIdParamSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    description:
      'Update workflow Queue/Skip concurrency policy at its independent revision. Requires workflow:update and active workspace. Positive cap requires active workspace entitlement; committed reservations are grandfathered. Does not publish or change trigger pause.',
    body: projected(
      'WorkflowConcurrencySettingsRequest',
      concurrency.workflowConcurrencySettingsRequestSchema,
    ),
    success: {
      status: 200,
      description:
        'Settings snapshot; exact retries replay the original result',
      body: projected(
        'WorkflowConcurrencyCommandResponse',
        concurrency.workflowConcurrencyCommandResponseSchema,
      ),
    },
    problems: {
      ...readProblems,
      '409': {
        description: 'Revision, current entitlement or idempotency conflict',
        ...conflictOf(
          'WorkflowConcurrencyRevisionConflictProblem',
          'WorkflowConcurrencyLimitExceededProblem',
        ),
      },
    },
  }),
  errorTargets: defineRoute({
    operationId: 'listWorkflowErrorTargets',
    method: 'get',
    path: `${WORKFLOW}/error-workflow/targets`,
    params: workflowIdParamSchema,
    query: errorWorkflow.workflowErrorTargetsQuerySchema,
    access: session('workflow:update'),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    description:
      'List a bounded page of active published error-workflow targets editable by the current person. Requires workflow:update. The current workflow is excluded.',
    success: {
      status: 200,
      description: 'Eligible targets and next cursor',
      body: projected(
        'WorkflowErrorTargetsPage',
        errorWorkflow.workflowErrorTargetsPageSchema,
      ),
    },
    problems: readProblems,
  }),
  errorWorkflow: defineRoute({
    operationId: 'getWorkflowErrorSettings',
    method: 'get',
    path: `${WORKFLOW}/error-workflow`,
    params: workflowIdParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    description:
      'Read the current error-workflow target. Requires workflow:read in the active workspace.',
    success: {
      status: 200,
      description: 'Current workflow error-workflow snapshot',
      body: projected(
        'WorkflowErrorSettings',
        errorWorkflow.workflowErrorSettingsSchema,
      ),
    },
    problems: readProblems,
  }),
  updateErrorWorkflow: defineRoute({
    operationId: 'updateWorkflowErrorSettings',
    method: 'put',
    path: `${WORKFLOW}/error-workflow`,
    params: workflowIdParamSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    description:
      'Select a published error workflow in this workspace or clear it. Requires workflow:update on source and target. Revision and idempotency protect concurrent updates.',
    body: projected(
      'WorkflowErrorSettingsRequest',
      errorWorkflow.workflowErrorSettingsRequestSchema,
    ),
    success: {
      status: 200,
      description:
        'Settings snapshot; exact retries replay the original result',
      body: projected(
        'WorkflowErrorSettingsResponse',
        errorWorkflow.workflowErrorSettingsResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '404', '500', '409'),
  }),
  autoPause: defineRoute({
    operationId: 'getWorkflowAutoPauseSettings',
    method: 'get',
    path: `${WORKFLOW}/auto-pause`,
    params: workflowIdParamSchema,
    access: { ...reading, auth: 'session_or_token' },
    rateLimit: 'authenticated_read',
    description:
      'Read automatic-trigger pause state and effective settings. Requires workflow:read.',
    success: {
      status: 200,
      description:
        'Read automatic-trigger pause state and effective settings. Requires workflow:read.',
      body: projected(
        'WorkflowAutoPauseSettings',
        autoPause.workflowAutoPauseSettingsSchema,
      ),
    },
    problems: readProblems,
  }),
  updateAutoPause: defineRoute({
    operationId: 'updateWorkflowAutoPauseSettings',
    method: 'put',
    path: `${WORKFLOW}/auto-pause`,
    params: workflowIdParamSchema,
    access: { ...updating, auth: 'session_or_token' },
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    description:
      'Update override or opt-out at the independent settings revision. Requires workflow:update. Does not resume, publish, enable triggers, or retroactively evaluate outcomes.',
    body: projected(
      'WorkflowAutoPauseSettingsRequest',
      autoPause.workflowAutoPauseSettingsRequestSchema,
    ),
    success: { status: 200, description: replayed, body: autoPauseCommand },
    problems: {
      ...readProblems,
      '409': {
        description: 'Expected revision or idempotency conflict',
        ...conflictOf('WorkflowAutoPauseSettingsConflictProblem'),
      },
    },
  }),
  resume: defineRoute({
    operationId: 'resumeWorkflow',
    method: 'post',
    path: `${WORKFLOW}/resume`,
    params: workflowIdParamSchema,
    access: { ...publishing, auth: 'session_or_token' },
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    description:
      'Explicitly clear automatic-trigger pause and reset the failure streak at the expected pause revision. Requires workflow:publish. An already-unpaused workflow is a no-op. Existing trigger disable states and workflow lifecycle are preserved.',
    body: projected(
      'WorkflowResumeRequest',
      autoPause.workflowResumeRequestSchema,
    ),
    success: { status: 200, description: replayed, body: autoPauseCommand },
    problems: {
      ...readProblems,
      '409': {
        description: 'Expected revision or idempotency conflict',
        ...conflictOf('WorkflowPauseConflictProblem'),
      },
    },
  }),
  workspaceAutoPause: defineRoute({
    operationId: 'getWorkspaceAutoPauseSettings',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/auto-pause',
    params: workspaceParams,
    access: session('workspace:read', BROWSABLE_WORKSPACE_STATUSES),
    rateLimit: 'authenticated_read',
    description:
      'Read workspace automatic-pause default. Requires workspace:read.',
    success: {
      status: 200,
      description:
        'Read workspace automatic-pause default. Requires workspace:read.',
      body: projected(
        'WorkspaceAutoPauseSettings',
        autoPause.workspaceAutoPauseSettingsSchema,
      ),
    },
    problems: readProblems,
  }),
  updateWorkspaceAutoPause: defineRoute({
    operationId: 'updateWorkspaceAutoPauseSettings',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/auto-pause',
    params: workspaceParams,
    access: session('workspace:manage'),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    description:
      'Update the workspace default threshold at the expected workspace revision. Requires workspace:manage (owner only). Does not resume or retroactively evaluate workflows.',
    body: projected(
      'WorkspaceAutoPauseSettingsRequest',
      autoPause.workspaceAutoPauseSettingsRequestSchema,
    ),
    success: {
      status: 200,
      description: replayed,
      body: projected(
        'WorkspaceAutoPauseCommandResponse',
        autoPause.workspaceAutoPauseCommandResponseSchema,
      ),
    },
    problems: {
      ...readProblems,
      '409': {
        description: 'Expected revision or idempotency conflict',
        ...conflictOf('WorkspaceAutoPauseSettingsConflictProblem'),
      },
    },
  }),
};
