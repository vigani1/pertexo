import * as schemas from '../../schemas/workflows/authoring.js';
import { projected, reading, updating } from './access.js';
const automationReading = { ...reading, auth: 'session_or_token' } as const;

import { responseReference } from '../openapi-primitives.js';
import { defineRoute } from '../define.js';
export const versionRoutes = {
  restoreVersion: defineRoute({
    operationId: 'restoreWorkflowVersion',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions/{versionId}/restore',
    params: schemas.workflowVersionRestoreParamsSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    description:
      'Copy an immutable version into the current draft with strong concurrency control. Preserves displaced unpublished edits as a disabled recovery workflow. Does not publish or change workflow lifecycle. An exact retry with the same idempotency key replays the accepted restore and recovery copy id; a new attempt with a stale tag returns 412.',
    body: projected(
      'WorkflowVersionRestoreRequest',
      schemas.workflowVersionRestoreRequestSchema,
    ),
    precondition: {
      description: 'One strong opaque draft representation validator',
      schema: schemas.strongEtagSchema,
    },
    success: {
      status: 200,
      description: 'Workflow draft restored',
      body: projected(
        'WorkflowVersionRestoreResponse',
        schemas.workflowVersionRestoreResponseSchema,
      ),
      headers: {
        ETag: {
          description: 'Strong opaque validator for this draft representation',
          required: true,
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'string',
            pattern: '^"draft\\.[A-Za-z0-9_-]{43}"$',
          },
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
  versions: defineRoute({
    operationId: 'listWorkflowVersions',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions',
    params: schemas.workflowIdParamSchema,
    access: automationReading,
    rateLimit: 'authenticated_read',
    query: schemas.workflowVersionsQuerySchema,
    success: {
      status: 200,
      description: 'Immutable workflow versions',
      body: projected(
        'WorkflowVersionsResponse',
        schemas.workflowVersionsResponseSchema,
      ),
    },
    problems: {
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '429': {
        description: 'Rate limited; see Retry-After',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ApiProblem' },
          },
        },
      },
      '500': responseReference('Unexpected'),
      '503': {
        description:
          'Automation token authentication, limiter or operation dependencies unavailable',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ApiProblem' },
          },
        },
      },
    },
  }),
};
