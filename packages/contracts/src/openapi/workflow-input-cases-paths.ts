import type { z } from 'zod';
import * as schemas from '../schemas/workflow-input-cases.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  responseReference,
  uuidPathParameter,
} from './primitives.js';

export function workflowInputCaseContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowInputCaseMetadata: project(
      'WorkflowInputCaseMetadata',
      schemas.workflowInputCaseMetadataSchema,
      'output',
    ),
    WorkflowInputCaseResponse: project(
      'WorkflowInputCaseResponse',
      schemas.workflowInputCaseResponseSchema,
      'output',
    ),
    WorkflowInputCaseListResponse: project(
      'WorkflowInputCaseListResponse',
      schemas.workflowInputCaseListResponseSchema,
      'output',
    ),
    WorkflowInputCaseCreateRequest: project(
      'WorkflowInputCaseCreateRequest',
      schemas.workflowInputCaseCreateRequestSchema,
      'input',
    ),
    WorkflowInputCaseUpdateRequest: project(
      'WorkflowInputCaseUpdateRequest',
      schemas.workflowInputCaseUpdateRequestSchema,
      'input',
    ),
    WorkflowInputCaseCommandResponse: project(
      'WorkflowInputCaseCommandResponse',
      schemas.workflowInputCaseCommandResponseSchema,
      'output',
    ),
  };
}
const parameters = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const itemParameters = [
  ...parameters,
  uuidPathParameter('caseId', 'Run-input case identifier'),
];
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '500': responseReference('Unexpected'),
};
const commandErrors = { ...errors, '409': responseReference('Conflict') };
const conditionalErrors = {
  ...commandErrors,
  '428': responseReference('PreconditionRequired'),
  '412': {
    description:
      'Run-input case representation changed; refetch and deliberately confirm a new command',
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ApiProblem' },
      },
    },
  },
};
const conditionalParameters = [
  ...itemParameters,
  csrfHeaderParameter(),
  idempotencyHeaderParameter(),
  {
    name: 'If-Match',
    in: 'header',
    required: true,
    description: 'One strong opaque run-input case representation validator',
    schema: jsonSchema(schemas.workflowInputCaseTagSchema, 'input'),
  },
];
export const workflowInputCaseContractPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/input-cases': {
    get: {
      operationId: 'listWorkflowInputCases',
      description:
        'List shared version-contextual case metadata only. Requires current workflow:read; no-store. Loading never starts a run.',
      security: [{ cookieSession: [] }],
      parameters: [
        ...parameters,
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: 'after',
          in: 'query',
          required: false,
          schema: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      ],
      responses: {
        '200': jsonResponse(
          'Bounded case metadata page',
          'WorkflowInputCaseListResponse',
        ),
        ...errors,
      },
    },
    post: {
      operationId: 'createWorkflowInputCase',
      description:
        'Create a manually entered synthetic run-input case bound to a retained published version. Requires workflow:update; never runs a workflow. Exact retries recover the original identifiers for 24 hours.',
      security: [{ cookieSession: [] }],
      parameters: [
        ...parameters,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('WorkflowInputCaseCreateRequest'),
      responses: {
        '201': jsonResponse(
          'Original case identifiers; fetch current representation separately',
          'WorkflowInputCaseCommandResponse',
        ),
        ...commandErrors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/input-cases/{caseId}': {
    get: {
      operationId: 'getWorkflowInputCase',
      description:
        'Read one current case payload with workflow:read. Deleted cases cannot be loaded; previously copied input is detached. No-store.',
      security: [{ cookieSession: [] }],
      parameters: itemParameters,
      responses: {
        '200': {
          ...jsonResponse(
            'Current case and bounded JSON',
            'WorkflowInputCaseResponse',
          ),
          headers: {
            ETag: {
              description: 'Strong opaque current case validator',
              required: true,
              schema: jsonSchema(schemas.workflowInputCaseTagSchema, 'output'),
            },
          },
        },
        ...errors,
      },
    },
    put: {
      operationId: 'updateWorkflowInputCase',
      description:
        'Update name/input without rebinding version. Requires workflow:update and strong If-Match. Current authority and retained exact recovery precede CAS. Receipt contains identifiers only.',
      security: [{ cookieSession: [] }],
      parameters: conditionalParameters,
      requestBody: jsonRequest('WorkflowInputCaseUpdateRequest'),
      responses: {
        '200': jsonResponse(
          'Original committed identifiers',
          'WorkflowInputCaseCommandResponse',
        ),
        ...conditionalErrors,
      },
    },
    delete: {
      operationId: 'deleteWorkflowInputCase',
      description:
        'Logically hide a case; held payload bytes remain charged until physical erasure. Requires workflow:update and strong If-Match. Exact retry never resurrects a deleted case.',
      security: [{ cookieSession: [] }],
      parameters: conditionalParameters,
      responses: {
        '200': jsonResponse(
          'Original deletion identifiers',
          'WorkflowInputCaseCommandResponse',
        ),
        ...conditionalErrors,
      },
    },
  },
};
