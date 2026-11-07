import { problemResponse } from '../openapi-primitives.js';
import * as folders from '../../schemas/workflows/organization-folders.js';
import * as organization from '../../schemas/workflows/organization.js';
import { projected, session, workspaceParams } from './access.js';
const participating = session('workflow:read');

import { responseReference } from '../openapi-primitives.js';
import { defineRoute } from '../define.js';
const sharedProblems1 = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': problemResponse(
    'Known organization, revision, idempotency or lifecycle conflict; retain uncertain commands for explicit exact recovery',
  ),
  '429': problemResponse('Request rate limit reached'),
  '500': responseReference('Unexpected'),
  '503': problemResponse(
    'Workflow organization or request admission is unavailable; no empty metadata is inferred',
  ),
};
export const batchRoutes = {
  bulk: defineRoute({
    operationId: 'updateWorkflowOrganizationBulk',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/organization/bulk',
    params: workspaceParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'One move or replace_tags operation over 1–50 explicit ordered unique workflows, never select-all. Active workflows require workflow:update; archived move requires owner/admin, archived tag replacement is forbidden. Full-parent identity is admitted before independent sequential item transactions; admission is not atomic completion. Retain the entire frozen body/key on unknown outcomes; exact recovery is bounded to 24 hours. Recheck current authority per item/replay; forbidden stops processing and remaining items are not_processed. Historical replay is not current projection; no internal hash, proof or actor selectors.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowOrganizationBulkRequest',
      folders.workflowOrganizationBulkRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description:
        'Original committed metadata and replay marker; reread current state',
      body: projected(
        'WorkflowOrganizationBulkResponse',
        folders.workflowOrganizationBulkResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems1,
  }),
  cleanup: defineRoute({
    operationId: 'detachWorkflowTagAssignments',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflow-tags/cleanup/detach',
    params: workspaceParams,
    access: participating,
    rateLimit: 'ordinary_mutation',
    description:
      'Current owner/admin; detach 1–50 explicit targets including archived workflows using independent ordered transactions. Recheck authority per item and replay. After forbidden, remaining items are not_processed. outcome_unknown is ambiguous, never a claimed failure. Exact recovery retains the frozen body and item identities; successful receipt metadata is not a current projection.',
    cacheControl: 'private, no-store',
    body: projected(
      'WorkflowTagCleanupDetachRequest',
      organization.workflowTagCleanupDetachRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Ordered bounded per-item outcomes',
      body: projected(
        'WorkflowTagCleanupDetachResponse',
        organization.workflowTagCleanupDetachResponseSchema,
      ),
      headers: {
        'Cache-Control': {
          required: true,
          schema: { type: 'string', const: 'private, no-store' },
        },
      },
    },
    problems: sharedProblems1,
  }),
};
