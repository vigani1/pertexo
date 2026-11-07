import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import * as schemas from '../../schemas/workflows/authoring.js';
import { projected, publishing, updating } from './access.js';

import { responseReference } from '../openapi-primitives.js';
import { defineRoute } from '../define.js';
export const lifecycleRoutes = {
  archive: defineRoute({
    operationId: 'archiveWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/archive',
    params: schemas.workflowIdParamSchema,
    access: { ...publishing, auth: 'session_or_token' },
    rateLimit: 'ordinary_mutation',
    description:
      'Change desired lifecycle without changing drafts, published versions, or existing runs. Exact idempotent retries return the original accepted summary.',
    body: projected(
      'WorkflowLifecycleRequest',
      schemas.workflowLifecycleRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 202,
      description: 'Workflow lifecycle accepted',
      body: projected(
        'WorkflowLifecycleResponse',
        schemas.workflowLifecycleResponseSchema,
      ),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': {
        description: 'Lifecycle revision or idempotency conflict',
        content: {
          'application/problem+json': {
            schema: {
              oneOf: [
                {
                  $ref: '#/components/schemas/WorkflowLifecycleConflictProblem',
                },
                { $ref: '#/components/schemas/ApiProblem' },
              ],
            },
          },
        },
      },
      '500': responseReference('Unexpected'),
    },
  }),
  restore: defineRoute({
    operationId: 'restoreWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/restore',
    params: schemas.workflowIdParamSchema,
    access: { ...publishing, auth: 'session_or_token' },
    rateLimit: 'ordinary_mutation',
    description:
      'Change desired lifecycle without changing drafts, published versions, or existing runs. Exact idempotent retries return the original accepted summary.',
    body: projected(
      'WorkflowLifecycleRequest',
      schemas.workflowLifecycleRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 202,
      description: 'Workflow lifecycle accepted',
      body: projected(
        'WorkflowLifecycleResponse',
        schemas.workflowLifecycleResponseSchema,
      ),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': {
        description: 'Lifecycle revision or idempotency conflict',
        content: {
          'application/problem+json': {
            schema: {
              oneOf: [
                {
                  $ref: '#/components/schemas/WorkflowLifecycleConflictProblem',
                },
                { $ref: '#/components/schemas/ApiProblem' },
              ],
            },
          },
        },
      },
      '500': responseReference('Unexpected'),
    },
  }),
  rename: defineRoute({
    operationId: 'renameWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/rename',
    params: schemas.workflowIdParamSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    description:
      'Change the display name at the expected name revision without changing drafts, published versions, lifecycle, or runs. Exact idempotent retries return the original accepted summary.',
    body: projected(
      'WorkflowRenameRequest',
      schemas.workflowRenameRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 200,
      description: 'Workflow renamed',
      body: projected(
        'WorkflowRenameResponse',
        schemas.workflowRenameResponseSchema,
      ),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': {
        description: 'Name revision or idempotency conflict',
        content: {
          'application/problem+json': {
            schema: {
              oneOf: [
                { $ref: '#/components/schemas/WorkflowNameConflictProblem' },
                { $ref: '#/components/schemas/ApiProblem' },
              ],
            },
          },
        },
      },
      '500': responseReference('Unexpected'),
    },
  }),
  duplicate: defineRoute({
    operationId: 'duplicateWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/duplicate',
    params: schemas.workflowIdParamSchema,
    access: {
      auth: 'session',
      capabilities: [
        {
          name: 'workflow:read',
          statuses: ACTIVE_WORKSPACE_STATUSES,
          disclosure: 'not_found',
        },
        {
          name: 'workflow:create',
          statuses: ACTIVE_WORKSPACE_STATUSES,
          disclosure: 'not_found',
        },
      ],
    },
    rateLimit: 'ordinary_mutation',
    description:
      'Create an independent unpublished workflow from the saved draft or the exact retained version. Draft source requires a single strong If-Match; version source does not. Exact authorized retries return the original destination.',
    precondition: {
      when: 'source.kind=draft',
      description:
        'Required only for source.kind=draft; binds the saved source representation.',
      schema: schemas.strongEtagSchema,
    },
    body: projected(
      'WorkflowDuplicateRequest',
      schemas.workflowDuplicateRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 201,
      description: 'Workflow duplicated',
      body: projected(
        'WorkflowDuplicateResponse',
        schemas.workflowDuplicateResponseSchema,
      ),
      headers: {
        Location: {
          description: 'Authorized destination workflow path',
          required: true,
          schema: { type: 'string' },
        },
      },
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('Conflict'),
      '412': responseReference('PreconditionFailed'),
      '422': responseReference('PublicationUnprocessable'),
      '428': responseReference('PreconditionRequired'),
      '500': responseReference('Unexpected'),
    },
  }),
};
