import { apiProblemSchema } from './errors/api-problem.js';
import {
  workflowCompatibilityReportSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowListResponseSchema,
  workflowListQuerySchema,
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
import { z } from 'zod';

export * from './http/workflow-authoring.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  WorkflowRevisionConflictProblem: jsonSchema(
    workflowRevisionConflictProblemSchema,
    'output',
  ),
  WorkflowCreateRequest: jsonSchema(workflowCreateRequestSchema, 'input'),
  WorkflowCreateResponse: jsonSchema(workflowCreateResponseSchema, 'output'),
  WorkflowSummary: jsonSchema(workflowSummarySchema, 'output'),
  WorkflowListResponse: jsonSchema(workflowListResponseSchema, 'output'),
  WorkflowDraftSaveRequest: jsonSchema(workflowDraftSaveRequestSchema, 'input'),
  WorkflowDraftResponse: jsonSchema(workflowDraftResponseSchema, 'output'),
  WorkflowCompatibilityReport: jsonSchema(
    workflowCompatibilityReportSchema,
    'output',
  ),
  WorkflowValidationResponse: jsonSchema(
    workflowValidateResponseSchema,
    'output',
  ),
  WorkflowPublishResponse: jsonSchema(workflowPublishResponseSchema, 'output'),
  WorkflowVersionResponse: jsonSchema(workflowVersionResponseSchema, 'output'),
  WorkflowVersionsResponse: jsonSchema(
    workflowVersionsResponseSchema,
    'output',
  ),
});

export const workflowAuthoringClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas,
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  PreconditionRequired: problemResponse('Precondition required'),
  PreconditionFailed: {
    description: 'The draft representation is no longer current',
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
const etagResponseHeader = {
  ETag: {
    description: 'Strong opaque validator for this draft representation',
    required: true,
    schema: jsonSchema(strongEtagSchema, 'output'),
  },
} as const;

export const workflowAuthoringOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Workflow Authoring API',
    version: '1.0.0',
  },
  paths: {
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
          '201': jsonResponse('Workflow created', 'WorkflowCreateResponse'),
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
  components: {
    schemas,
    responses: problemResponses,
    securitySchemes: {
      cookieSession: {
        type: 'apiKey',
        in: 'cookie',
        name: 'pertexo_session',
      },
    },
  },
});

type SchemaName = keyof typeof schemas;
type ProblemResponseName = keyof typeof problemResponses;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
}
function schemaReference(name: SchemaName): Readonly<{ $ref: string }> {
  return { $ref: `#/components/schemas/${name}` };
}
function responseReference(
  name: ProblemResponseName,
): Readonly<{ $ref: string }> {
  return { $ref: `#/components/responses/${name}` };
}
function jsonRequest(name: SchemaName) {
  return {
    required: true,
    content: { 'application/json': { schema: schemaReference(name) } },
  } as const;
}
function jsonResponse(description: string, name: SchemaName) {
  return {
    description,
    content: { 'application/json': { schema: schemaReference(name) } },
  } as const;
}
function jsonResponseWithHeaders(
  description: string,
  name: SchemaName,
  headers: Readonly<Record<string, unknown>>,
) {
  return { ...jsonResponse(description, name), headers } as const;
}
function problemResponse(description: string) {
  return {
    description,
    content: {
      'application/problem+json': { schema: schemaReference('ApiProblem') },
    },
  } as const;
}
function pathParameter(
  name: 'workspaceId' | 'workflowId',
  description: string,
) {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: jsonSchema(z.uuid(), 'input'),
  } as const;
}
function queryParameter(name: 'limit' | 'after', schema: z.ZodType) {
  return {
    name,
    in: 'query',
    required: false,
    schema: jsonSchema(schema, 'input'),
  } as const;
}
