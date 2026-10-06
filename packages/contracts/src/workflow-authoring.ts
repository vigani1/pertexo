import { workflowAuthoringContractSchemas } from './workflow-authoring-schema-projection.js';

import {
  workflowOrganizationContractPaths,
  workflowOrganizationGetReadContract,
  workflowOrganizationListReadContract,
} from './workflow-organization-contract.js';
import { workflowInputCaseContractPaths } from './workflow-input-cases-contract.js';
import { workflowConcurrencyContractPaths } from './workflow-concurrency-contract.js';
import { workflowAutoPauseContractPaths } from './workflow-auto-pause-contract.js';
import {
  workflowVersionsQuerySchema,
  strongEtagSchema,
} from './http/workflow-authoring.js';

import { workflowRevisionCommandPaths } from './workflow-revision-commands-contract.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
  uuidPathParameter as pathParameter,
} from './openapi-primitives.js';
import type { z } from 'zod';

export * from './http/workflow-authoring.js';

const clientSchemas = workflowAuthoringContractSchemas('client');
const openApiSchemas = workflowAuthoringContractSchemas('openapi');

export const workflowAuthoringClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas: clientSchemas,
});

const etagResponseHeader = {
  ETag: {
    description: 'Strong opaque validator for this draft representation',
    required: true,
    schema: jsonSchema(strongEtagSchema, 'output'),
  },
} as const;

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unavailable: problemResponse('Historical template origin unavailable'),
  ValidationUnavailable: {
    ...problemResponse('Workflow validation temporarily unavailable'),
    headers: {
      'Retry-After': {
        description: 'Bounded explicit-retry delay in seconds',
        required: true,
        schema: { type: 'integer', const: 1 },
      },
    },
  },
  PreconditionRequired: problemResponse('Precondition required'),
  PreconditionFailed: {
    description: 'The draft representation is no longer current',
    headers: etagResponseHeader,
    content: {
      'application/problem+json': {
        schema: {
          $ref: '#/components/schemas/WorkflowRevisionConflictProblem',
        },
      },
    },
  },
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  UnprocessableEntity: problemResponse('Workflow is not publishable'),
  Unexpected: problemResponse('Unexpected server error'),
});

const pathParameters = [
  pathParameter('workspaceId', 'Workspace identifier'),
] as const;
const workflowParameters = [
  ...pathParameters,
  pathParameter('workflowId', 'Workflow identifier'),
] as const;
const etagParameter = {
  name: 'If-Match',
  in: 'header',
  required: true,
  schema: jsonSchema(strongEtagSchema, 'input'),
} as const;
const idempotencyParameter = idempotencyHeaderParameter();
const csrfParameter = csrfHeaderParameter();

export const workflowAuthoringOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Workflow Authoring API',
    version: '1.0.0',
  },
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/duplicate': {
      post: {
        operationId: 'duplicateWorkflow',
        description:
          'Create an independent unpublished workflow from the saved draft or the exact retained version. Draft source requires a single strong If-Match; version source does not. Exact authorized retries return the original destination.',
        security: [{ cookieSession: [] }],
        parameters: [
          ...workflowParameters,
          csrfParameter,
          idempotencyParameter,
          {
            ...etagParameter,
            required: false,
            description:
              'Required only for source.kind=draft; binds the saved source representation.',
          },
        ],
        requestBody: jsonRequest('WorkflowDuplicateRequest'),
        responses: {
          '201': jsonResponseWithHeaders(
            'Workflow duplicated',
            'WorkflowDuplicateResponse',
            {
              Location: {
                description: 'Authorized destination workflow path',
                required: true,
                schema: { type: 'string' },
              },
            },
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '412': responseReference('PreconditionFailed'),
          '422': responseReference('UnprocessableEntity'),
          '428': responseReference('PreconditionRequired'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions/{versionId}/restore':
      {
        post: {
          operationId: 'restoreWorkflowVersion',
          description:
            'Copy an immutable version into the current draft with strong concurrency control. Does not publish or change workflow lifecycle. A committed retry with the old tag returns 412.',
          security: [{ cookieSession: [] }],
          parameters: [
            ...workflowParameters,
            {
              name: 'versionId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            csrfParameter,
            etagParameter,
          ],
          requestBody: jsonRequest('WorkflowVersionRestoreRequest'),
          responses: {
            '200': jsonResponseWithHeaders(
              'Workflow draft restored',
              'WorkflowDraftResponse',
              etagResponseHeader,
            ),
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '412': responseReference('PreconditionFailed'),
            '422': responseReference('UnprocessableEntity'),
            '428': responseReference('PreconditionRequired'),
            '500': responseReference('Unexpected'),
          },
        },
      },
    ...workflowRevisionCommandPaths,
    '/v1/workspaces/{workspaceId}/workflows': {
      get: {
        operationId: 'listWorkflows',
        security: [{ cookieSession: [] }],
        parameters: [
          ...pathParameters,
          ...workflowOrganizationListReadContract.parameters,
        ],
        responses: {
          '200': workflowOrganizationListReadContract.response,
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '503': problemResponse('Workflow organization unavailable'),
          '500': responseReference('Unexpected'),
        },
      },
      post: {
        operationId: 'createWorkflow',
        security: [{ cookieSession: [] }],
        parameters: [...pathParameters, csrfParameter, idempotencyParameter],
        requestBody: jsonRequest('WorkflowCreateRequest'),
        responses: {
          '201': jsonResponseWithHeaders(
            'Workflow created',
            'WorkflowCreateResponse',
            etagResponseHeader,
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}': {
      get: {
        operationId: 'getWorkflow',
        description:
          'Default metadata retains its strict shape. include is exactly templateOrigin, organization, or templateOrigin,organization. Unsupported projection is unavailable, never inferred null or empty.',
        security: [{ cookieSession: [] }],
        parameters: [
          ...workflowParameters,
          workflowOrganizationGetReadContract.parameter,
        ],
        responses: {
          '200': workflowOrganizationGetReadContract.response,
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
          '503': responseReference('Unavailable'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft': {
      get: {
        operationId: 'getWorkflowDraft',
        security: [{ cookieSession: [] }],
        parameters: workflowParameters,
        responses: {
          '200': jsonResponseWithHeaders(
            'Workflow draft',
            'WorkflowDraftResponse',
            etagResponseHeader,
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
      put: {
        operationId: 'saveWorkflowDraft',
        security: [{ cookieSession: [] }],
        parameters: [...workflowParameters, csrfParameter, etagParameter],
        requestBody: jsonRequest('WorkflowDraftSaveRequest'),
        responses: {
          '200': jsonResponseWithHeaders(
            'Workflow draft saved',
            'WorkflowDraftResponse',
            etagResponseHeader,
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '412': responseReference('PreconditionFailed'),
          '428': responseReference('PreconditionRequired'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate': {
      post: {
        operationId: 'validateWorkflowDraft',
        security: [{ cookieSession: [] }],
        parameters: [...workflowParameters, csrfParameter],
        responses: {
          '200': jsonResponseWithHeaders(
            'Workflow validation report',
            'WorkflowValidationResponse',
            etagResponseHeader,
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
          '503': responseReference('ValidationUnavailable'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish': {
      post: {
        operationId: 'publishWorkflow',
        security: [{ cookieSession: [] }],
        parameters: [
          ...workflowParameters,
          csrfParameter,
          etagParameter,
          idempotencyParameter,
        ],
        responses: {
          '200': jsonResponse('Workflow published', 'WorkflowPublishResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '412': responseReference('PreconditionFailed'),
          '428': responseReference('PreconditionRequired'),
          '422': responseReference('UnprocessableEntity'),
          '500': responseReference('Unexpected'),
          '503': responseReference('ValidationUnavailable'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions': {
      get: {
        operationId: 'listWorkflowVersions',
        description:
          'Without include, returns the unchanged strict WorkflowVersionsResponse. include=callableTarget returns only WorkflowCallableTargetsResponse (default limit 1, maximum 25); versionId performs an exact refresh and is mutually exclusive with limit/after. Unknown/repeated query fields are invalid. Raw generated callers must narrow the response union; legacy typed wrappers omit include and validate only the legacy schema. The actor-scoped projection is private, no-store, not publication or runtime authority; native OFF never yields eligible.',
        security: [{ cookieSession: [] }],
        parameters: [
          ...workflowParameters,
          queryParameter('limit', workflowVersionsQuerySchema.shape.limit),
          queryParameter('after', workflowVersionsQuerySchema.shape.after),
          {
            name: 'include',
            in: 'query',
            required: false,
            schema: { type: 'string', const: 'callableTarget' },
            description:
              'Opt-in strict callable target projection. Its page limit is 1–25, default 1; omitted include retains the legacy limit contract.',
          },
          {
            name: 'versionId',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'uuid' },
            description:
              'Requires include=callableTarget; mutually exclusive with limit and after. Exact refresh returns one item and null nextCursor or not found.',
          },
        ],
        responses: {
          '200': {
            description:
              'Immutable workflow versions or explicitly requested actor-scoped callable targets',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/WorkflowVersionsResponse' },
                    {
                      $ref: '#/components/schemas/WorkflowCallableTargetsResponse',
                    },
                  ],
                },
              },
            },
          },
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
          '503': {
            description:
              'Callable target assessment unavailable; no partially assessed page',
            content: {
              'application/problem+json': {
                schema: {
                  $ref: '#/components/schemas/WorkflowCallableTargetsUnavailableProblem',
                },
              },
            },
          },
        },
      },
    },
    ...workflowAutoPauseContractPaths,
    ...workflowConcurrencyContractPaths,
    ...workflowInputCaseContractPaths,
    ...workflowOrganizationContractPaths,
  },
  components: authenticatedComponents(openApiSchemas, problemResponses),
});

type SchemaName = keyof typeof openApiSchemas;
function jsonResponseWithHeaders(
  description: string,
  name: SchemaName,
  headers: Readonly<Record<string, unknown>>,
) {
  return { ...jsonResponse(description, name), headers } as const;
}
function queryParameter(name: 'limit' | 'after' | 'order', schema: z.ZodType) {
  return {
    name,
    in: 'query',
    required: false,
    schema: jsonSchema(schema, 'input'),
  } as const;
}
