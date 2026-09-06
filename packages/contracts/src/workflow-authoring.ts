import { apiProblemSchema } from './errors/api-problem.js';
import {
  workflowCompatibilityReportSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowListResponseSchema,
  workflowListQuerySchema,
  workflowLifecycleRequestSchema,
  workflowLifecycleResponseSchema,
  workflowLifecycleConflictProblemSchema,
  workflowVersionRestoreRequestSchema,
  workflowPublishResponseSchema,
  workflowRevisionConflictProblemSchema,
  workflowSummarySchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
  strongEtagSchema,
} from './http/workflow-authoring.js';
import { idempotencyKeySchema } from './http/identity-workspace.js';
import { projectContractSchema } from './schema-projection.js';
import {
  authenticatedComponents,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
  uuidPathParameter as pathParameter,
} from './openapi-primitives.js';
import { z } from 'zod';

export * from './http/workflow-authoring.js';

function contractSchemas(target: 'client' | 'openapi') {
  const project = (name: string, schema: z.ZodType, io: 'input' | 'output') =>
    projectContractSchema(name, schema, io, target);
  return Object.freeze({
    ApiProblem: project('ApiProblem', apiProblemSchema, 'output'),
    WorkflowVersionRestoreRequest: project(
      'WorkflowVersionRestoreRequest',
      workflowVersionRestoreRequestSchema,
      'input',
    ),
    WorkflowLifecycleRequest: project(
      'WorkflowLifecycleRequest',
      workflowLifecycleRequestSchema,
      'input',
    ),
    WorkflowLifecycleResponse: project(
      'WorkflowLifecycleResponse',
      workflowLifecycleResponseSchema,
      'output',
    ),
    WorkflowLifecycleConflictProblem: project(
      'WorkflowLifecycleConflictProblem',
      workflowLifecycleConflictProblemSchema,
      'output',
    ),
    WorkflowRevisionConflictProblem: project(
      'WorkflowRevisionConflictProblem',
      workflowRevisionConflictProblemSchema,
      'output',
    ),
    WorkflowCreateRequest: project(
      'WorkflowCreateRequest',
      workflowCreateRequestSchema,
      'input',
    ),
    WorkflowCreateResponse: project(
      'WorkflowCreateResponse',
      workflowCreateResponseSchema,
      'output',
    ),
    WorkflowSummary: project(
      'WorkflowSummary',
      workflowSummarySchema,
      'output',
    ),
    WorkflowListResponse: project(
      'WorkflowListResponse',
      workflowListResponseSchema,
      'output',
    ),
    WorkflowDraftSaveRequest: project(
      'WorkflowDraftSaveRequest',
      workflowDraftSaveRequestSchema,
      'input',
    ),
    WorkflowDraftResponse: project(
      'WorkflowDraftResponse',
      workflowDraftResponseSchema,
      'output',
    ),
    WorkflowCompatibilityReport: project(
      'WorkflowCompatibilityReport',
      workflowCompatibilityReportSchema,
      'output',
    ),
    WorkflowValidationResponse: project(
      'WorkflowValidationResponse',
      workflowValidateResponseSchema,
      'output',
    ),
    WorkflowPublishResponse: project(
      'WorkflowPublishResponse',
      workflowPublishResponseSchema,
      'output',
    ),
    WorkflowVersionResponse: project(
      'WorkflowVersionResponse',
      workflowVersionResponseSchema,
      'output',
    ),
    WorkflowVersionsResponse: project(
      'WorkflowVersionsResponse',
      workflowVersionsResponseSchema,
      'output',
    ),
  });
}
const clientSchemas = contractSchemas('client');
const openApiSchemas = contractSchemas('openapi');

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
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: jsonSchema(idempotencyKeySchema, 'input'),
} as const;
const csrfParameter = {
  name: 'x-csrf-token',
  in: 'header',
  required: true,
  schema: jsonSchema(z.string().min(16).max(512), 'input'),
} as const;

function lifecycleOperation(
  operationId: 'archiveWorkflow' | 'restoreWorkflow',
) {
  return {
    operationId,
    description:
      'Change desired lifecycle without changing drafts, published versions, or existing runs. Exact idempotent retries return the original accepted summary.',
    security: [{ cookieSession: [] }],
    parameters: [...workflowParameters, csrfParameter, idempotencyParameter],
    requestBody: jsonRequest('WorkflowLifecycleRequest'),
    responses: {
      '202': jsonResponse(
        'Workflow lifecycle accepted',
        'WorkflowLifecycleResponse',
      ),
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
  };
}
export const workflowAuthoringOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Workflow Authoring API',
    version: '1.0.0',
  },
  paths: {
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
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/archive': {
      post: lifecycleOperation('archiveWorkflow'),
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/restore': {
      post: lifecycleOperation('restoreWorkflow'),
    },
    '/v1/workspaces/{workspaceId}/workflows': {
      get: {
        operationId: 'listWorkflows',
        security: [{ cookieSession: [] }],
        parameters: [
          ...pathParameters,
          queryParameter('limit', workflowListQuerySchema.shape.limit),
          queryParameter('after', workflowListQuerySchema.shape.after),
        ],
        responses: {
          '200': jsonResponse('Workflows', 'WorkflowListResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
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
          '200': jsonResponse(
            'Workflow validation report',
            'WorkflowValidationResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
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
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions': {
      get: {
        operationId: 'listWorkflowVersions',
        security: [{ cookieSession: [] }],
        parameters: [
          ...workflowParameters,
          queryParameter('limit', workflowVersionsQuerySchema.shape.limit),
          queryParameter('after', workflowVersionsQuerySchema.shape.after),
        ],
        responses: {
          '200': jsonResponse(
            'Immutable workflow versions',
            'WorkflowVersionsResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
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
function queryParameter(name: 'limit' | 'after', schema: z.ZodType) {
  return {
    name,
    in: 'query',
    required: false,
    schema: jsonSchema(schema, 'input'),
  } as const;
}
