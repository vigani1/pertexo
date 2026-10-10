import { apiProblemSchema } from '../../errors/api-problem.js';
import {
  workflowOrganizationContractPaths,
  workflowOrganizationContractSchemas,
  workflowOrganizationGetReadContract,
  workflowOrganizationListReadContract,
} from './organization.js';
import {
  workflowInputCaseContractPaths,
  workflowInputCaseContractSchemas,
} from './input-cases.js';
import {
  workflowConcurrencyContractPaths,
  workflowConcurrencyContractSchemas,
} from './concurrency.js';
import {
  workflowAutoPauseContractPaths,
  workflowAutoPauseContractSchemas,
} from './auto-pause.js';
import {
  workflowCompatibilityReportSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDuplicateRequestSchema,
  workflowDuplicateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowListResponseSchema,
  workflowVersionRestoreRequestSchema,
  workflowPublishResponseSchema,
  workflowRevisionConflictProblemSchema,
  workflowSummarySchema,
  workflowSummaryResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
  strongEtagSchema,
} from '../../schemas/workflows/authoring.js';
import { projectContractSchema } from '../schema-projection.js';
import {
  workflowRevisionCommandPaths,
  workflowRevisionCommandSchemas,
} from './revision-commands.js';
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
} from '../primitives.js';
import type { z } from 'zod';

function contractSchemas(target: 'client' | 'openapi') {
  const project = (name: string, schema: z.ZodType, io: 'input' | 'output') =>
    projectContractSchema(name, schema, io, target);
  return Object.freeze({
    ApiProblem: project('ApiProblem', apiProblemSchema, 'output'),
    WorkflowDuplicateRequest: project(
      'WorkflowDuplicateRequest',
      workflowDuplicateRequestSchema,
      'input',
    ),
    WorkflowDuplicateResponse: project(
      'WorkflowDuplicateResponse',
      workflowDuplicateResponseSchema,
      'output',
    ),
    WorkflowVersionRestoreRequest: project(
      'WorkflowVersionRestoreRequest',
      workflowVersionRestoreRequestSchema,
      'input',
    ),
    ...workflowRevisionCommandSchemas(project),
    ...workflowAutoPauseContractSchemas(project),
    ...workflowConcurrencyContractSchemas(project),
    ...workflowInputCaseContractSchemas(project),
    ...workflowOrganizationContractSchemas(project),
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
    WorkflowSummaryResponse: project(
      'WorkflowSummaryResponse',
      workflowSummaryResponseSchema,
      'output',
    ),
    WorkflowTemplateOriginProjectionResponse: project(
      'WorkflowTemplateOriginProjectionResponse',
      workflowTemplateOriginProjectionResponseSchema,
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
