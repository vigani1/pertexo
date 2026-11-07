import { z } from 'zod';
import * as schemas from '../../schemas/workflows/authoring.js';
import {
  projected,
  publishing,
  reading,
  session,
  updating,
  workspaceParams,
} from './access.js';
const automationReading = { ...reading, auth: 'session_or_token' } as const;
const automationCreating = {
  ...session('workflow:create'),
  auth: 'session_or_token',
} as const;
const automationUpdating = { ...updating, auth: 'session_or_token' } as const;
const automationPublishing = {
  ...publishing,
  auth: 'session_or_token',
} as const;

import { responseReference } from '../openapi-primitives.js';
import { defineRoute } from '../define.js';
export const authoringRoutes = {
  list: defineRoute({
    operationId: 'listWorkflows',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows',
    params: workspaceParams,
    access: automationReading,
    rateLimit: 'authenticated_read',
    query: schemas.workflowOrganizationListQuerySchema,
    success: {
      status: 200,
      response: {
        description:
          'Default or filtered workflow summaries; include=organization explicitly requests private organization metadata. Filters apply before bounded pagination; unknown/foreign tag or folder filters return an empty scoped page. folderId selects an exact UUID without descendants, root selects unfiled, and omission includes all placements. pinsWorkflowId lists workflows whose current publication directly pins that target, using the ordinary list response and cursor; it cannot be combined with organization filters. Live pagination is not a snapshot and has no total count.',
        headers: {
          'Cache-Control': {
            schema: { type: 'string', const: 'private, no-store' },
          },
        },
        content: {
          'application/json': {
            schema: {
              anyOf: [
                { $ref: '#/components/schemas/WorkflowListResponse' },
                {
                  $ref: '#/components/schemas/WorkflowOrganizationListResponse',
                },
              ],
            },
          },
        },
      },
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
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
  create: defineRoute({
    operationId: 'createWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows',
    params: workspaceParams,
    access: automationCreating,
    rateLimit: 'ordinary_mutation',
    body: projected(
      'WorkflowCreateRequest',
      schemas.workflowCreateRequestSchema,
    ),
    idempotent: true,
    success: {
      status: 201,
      description: 'Workflow created',
      body: projected(
        'WorkflowCreateResponse',
        schemas.workflowCreateResponseSchema,
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
      '409': responseReference('Conflict'),
      '500': responseReference('Unexpected'),
    },
  }),
  get: defineRoute({
    operationId: 'getWorkflow',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}',
    params: schemas.workflowIdParamSchema,
    access: automationReading,
    rateLimit: 'authenticated_read',
    description:
      'Default metadata retains its strict shape. include is exactly templateOrigin, organization, or templateOrigin,organization. Unsupported projection is unavailable, never inferred null or empty.',
    query: schemas.workflowGetQuerySchema,
    success: {
      status: 200,
      response: {
        description:
          'Unchanged default metadata, or the exact requested template-origin and/or organization projection. Unsupported readers are unavailable, never fabricated empty metadata.',
        headers: {
          'Cache-Control': {
            schema: { type: 'string', const: 'private, no-store' },
          },
        },
        content: {
          'application/json': {
            schema: {
              oneOf: [
                { $ref: '#/components/schemas/WorkflowSummaryResponse' },
                {
                  $ref: '#/components/schemas/WorkflowTemplateOriginProjectionResponse',
                },
                {
                  $ref: '#/components/schemas/WorkflowOrganizationProjectionResponse',
                },
                {
                  $ref: '#/components/schemas/WorkflowCombinedOrganizationProjectionResponse',
                },
              ],
            },
          },
        },
      },
    },
    problems: {
      '400': responseReference('BadRequest'),
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
  draft: defineRoute({
    operationId: 'getWorkflowDraft',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft',
    params: schemas.workflowIdParamSchema,
    access: automationReading,
    rateLimit: 'authenticated_read',
    headers: z.object({ 'if-none-match': z.string().optional() }),
    success: {
      status: 200,
      description: 'Workflow draft',
      body: projected(
        'WorkflowDraftResponse',
        schemas.workflowDraftResponseSchema,
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
    otherSuccesses: [
      {
        status: 304,
        response: { description: 'The draft still has this ETag' },
      },
    ],
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
  save: defineRoute({
    operationId: 'saveWorkflowDraft',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft',
    params: schemas.workflowIdParamSchema,
    access: automationUpdating,
    rateLimit: 'ordinary_mutation',
    body: projected(
      'WorkflowDraftSaveRequest',
      schemas.workflowDraftSaveRequestSchema,
    ),
    precondition: {
      description: 'One strong opaque draft representation validator',
      schema: schemas.strongEtagSchema,
    },
    success: {
      status: 200,
      description: 'Workflow draft saved',
      body: projected(
        'WorkflowDraftResponse',
        schemas.workflowDraftResponseSchema,
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
      '412': responseReference('PreconditionFailed'),
      '428': responseReference('PreconditionRequired'),
      '500': responseReference('Unexpected'),
    },
  }),
  validate: defineRoute({
    operationId: 'validateWorkflowDraft',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate',
    params: schemas.workflowIdParamSchema,
    access: reading,
    rateLimit: 'workflow_compile',
    success: {
      status: 200,
      description: 'Workflow validation report',
      body: projected(
        'WorkflowValidationResponse',
        schemas.workflowValidateResponseSchema,
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
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '500': responseReference('Unexpected'),
      '503': responseReference('ValidationUnavailable'),
    },
  }),
  publish: defineRoute({
    operationId: 'publishWorkflow',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish',
    params: schemas.workflowIdParamSchema,
    access: automationPublishing,
    rateLimit: 'workflow_compile',
    idempotent: true,
    precondition: {
      description: 'One strong opaque draft representation validator',
      schema: schemas.strongEtagSchema,
    },
    success: {
      status: 200,
      description: 'Workflow published',
      body: projected(
        'WorkflowPublishResponse',
        schemas.workflowPublishResponseSchema,
      ),
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
      '429': {
        description: 'Rate limited; see Retry-After',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ApiProblem' },
          },
        },
      },
      '500': responseReference('Unexpected'),
      '503': responseReference('PublicationUnavailable'),
    },
  }),
};
