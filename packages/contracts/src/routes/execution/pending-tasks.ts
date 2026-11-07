import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/policy';
import { z } from 'zod';

import { responseReference } from '../openapi-primitives.js';
import {
  approvalAudienceInspectionRequestSchema,
  approvalAudienceInspectionResponseSchema,
  approvalAudiencePageSchema,
  approvalAudienceQuerySchema,
  pendingTaskDecisionRequestSchema,
  pendingTaskDecisionResponseSchema,
  pendingTaskListQuerySchema,
  pendingTaskListResponseSchema,
  pendingTaskParamsSchema,
  pendingTaskResponseSchema,
  pendingTaskSubmitRequestSchema,
} from '../../schemas/execution/pending-tasks.js';
import { formUploadSessionSchema } from '../../schemas/forms/uploads.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/pending-tasks';
const TASK = `${ROOT}/{taskId}` as const;
const workspace = z.object({ workspaceId: z.uuid() }).strict();

function session(
  name: AuthorizationCapability,
  statuses: WorkspaceStatusList,
): RouteAccess {
  return {
    auth: 'session',
    capabilities: [{ name, statuses, disclosure: 'not_found' }],
  };
}
const reading = session('run:read', BROWSABLE_WORKSPACE_STATUSES);
/** Deciding and submitting need an active workspace; eligibility is per task. */
const responding = session('run:read', ACTIVE_WORKSPACE_STATUSES);
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '500': responseReference('Unexpected'),
};
const withConflict = { ...errors, '409': responseReference('Conflict') };
const noStore = 'private, no-store';
const decision = named(
  'PendingTaskDecisionResponse',
  pendingTaskDecisionResponseSchema,
);

export const pendingTaskRoutes = {
  inspectAudience: defineRoute({
    operationId: 'inspectApprovalAudience',
    method: 'post',
    path: `${ROOT}/audience/inspect`,
    params: workspace,
    access: session('workflow:update', ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    body: named(
      'ApprovalAudienceInspectionRequest',
      approvalAudienceInspectionRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Whole current audience for an advisory editor check',
      body: named(
        'ApprovalAudienceInspectionResponse',
        approvalAudienceInspectionResponseSchema,
      ),
    },
    problems: errors,
  }),
  submit: defineRoute({
    operationId: 'submitPendingTask',
    method: 'post',
    path: `${TASK}/submit`,
    params: pendingTaskParamsSchema,
    // Names the form session only when the answers reference uploads.
    headers: z.object({
      'x-pertexo-form-session': formUploadSessionSchema.optional(),
    }),
    access: responding,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    body: named('PendingTaskSubmitRequest', pendingTaskSubmitRequestSchema),
    success: { status: 200, description: 'Recorded input', body: decision },
    problems: withConflict,
  }),
  list: defineRoute({
    operationId: 'listPendingTasks',
    method: 'get',
    path: ROOT,
    params: workspace,
    query: pendingTaskListQuerySchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Durable tasks visible to this member',
      body: named('PendingTaskListResponse', pendingTaskListResponseSchema),
    },
    problems: errors,
  }),
  audience: defineRoute({
    operationId: 'listApprovalAudience',
    method: 'get',
    path: `${ROOT}/audience`,
    params: workspace,
    query: approvalAudienceQuerySchema,
    access: session('workflow:update', BROWSABLE_WORKSPACE_STATUSES),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Active member identities for approval setup',
      body: named('ApprovalAudiencePage', approvalAudiencePageSchema),
    },
    problems: errors,
  }),
  read: defineRoute({
    operationId: 'getPendingTask',
    method: 'get',
    path: TASK,
    params: pendingTaskParamsSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Task details and current decision eligibility',
      body: named('PendingTaskResponse', pendingTaskResponseSchema),
    },
    problems: errors,
  }),
  decide: defineRoute({
    operationId: 'decidePendingTask',
    method: 'post',
    path: `${TASK}/decide`,
    params: pendingTaskParamsSchema,
    access: responding,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    body: named('PendingTaskDecisionRequest', pendingTaskDecisionRequestSchema),
    success: {
      status: 200,
      description: 'One recorded decision, or its idempotent replay',
      body: decision,
    },
    problems: withConflict,
  }),
};
