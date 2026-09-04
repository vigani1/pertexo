import { z } from 'zod';

import { apiProblemSchema } from './errors/api-problem.js';
import { idempotencyKeySchema } from './http/identity-workspace.js';
import {
  nodeSideEffectDisclosureSchema,
  nodeTestExecuteAcceptedResponseSchema,
  nodeTestRequestSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
  previewRunSummarySchema,
} from './http/node-testing.js';
import { projectContractSchema } from './schema-projection.js';

export * from './http/node-testing.js';

function contractSchemas(target: 'client' | 'openapi') {
  return Object.freeze({
    ApiProblem: projectContractSchema(
      'ApiProblem',
      apiProblemSchema,
      'output',
      target,
    ),
    NodeTestRequest: projectContractSchema(
      'NodeTestRequest',
      nodeTestRequestSchema,
      'input',
      target,
    ),
    NodeSideEffectDisclosure: projectContractSchema(
      'NodeSideEffectDisclosure',
      nodeSideEffectDisclosureSchema,
      'output',
      target,
    ),
    NodeValidationResponse: projectContractSchema(
      'NodeValidationResponse',
      nodeValidationResponseSchema,
      'output',
      target,
    ),
    NodeTestExecuteAcceptedResponse: projectContractSchema(
      'NodeTestExecuteAcceptedResponse',
      nodeTestExecuteAcceptedResponseSchema,
      'output',
      target,
    ),
    PreviewRunSummary: projectContractSchema(
      'PreviewRunSummary',
      previewRunSummarySchema,
      'output',
      target,
    ),
    PreviewRunResponse: projectContractSchema(
      'PreviewRunResponse',
      previewRunResponseSchema,
      'output',
      target,
    ),
  });
}
const clientSchemas = contractSchemas('client');
const openApiSchemas = contractSchemas('openapi');

export const nodeTestingClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas: clientSchemas,
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  PreconditionRequired: problemResponse('Required request precondition'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  UnprocessableEntity: problemResponse('Node test input is not executable'),
  Unexpected: problemResponse('Unexpected server error'),
});

const workspaceParameter = pathParameter('workspaceId', 'Workspace identifier');
const workflowParameter = pathParameter('workflowId', 'Workflow identifier');
const nodeParameter = {
  ...pathParameter('nodeId', 'Workflow node identifier'),
  schema: jsonSchema(z.string().min(1).max(256), 'input'),
} as const;
const previewRunParameter = pathParameter(
  'previewRunId',
  'Preview run identifier',
);
const csrfParameter = {
  name: 'x-csrf-token',
  in: 'header',
  required: true,
  schema: jsonSchema(z.string().min(16).max(512), 'input'),
} as const;
const conditionalIdempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Required when request mode is test_execute; ignored for validate',
  schema: jsonSchema(idempotencyKeySchema, 'input'),
} as const;

export const nodeTestingOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Node Testing API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/test':
      {
        post: {
          operationId: 'testWorkflowNode',
          security: [{ cookieSession: [] }],
          parameters: [
            workspaceParameter,
            workflowParameter,
            nodeParameter,
            csrfParameter,
            conditionalIdempotencyParameter,
          ],
          requestBody: jsonRequest('NodeTestRequest'),
          responses: {
            '200': jsonResponse(
              'Read-only node validation',
              'NodeValidationResponse',
            ),
            '202': jsonResponse(
              'Durable node test execution accepted',
              'NodeTestExecuteAcceptedResponse',
            ),
            '400': responseReference('BadRequest'),
            '401': responseReference('Unauthenticated'),
            '403': responseReference('Forbidden'),
            '404': responseReference('NotFound'),
            '409': responseReference('Conflict'),
            '422': responseReference('UnprocessableEntity'),
            '428': responseReference('PreconditionRequired'),
            '500': responseReference('Unexpected'),
          },
        },
      },
    '/v1/workspaces/{workspaceId}/previews/{previewRunId}': {
      get: {
        operationId: 'getPreviewRun',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, previewRunParameter],
        responses: {
          '200': jsonResponse('Preview run status', 'PreviewRunResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
  },
  components: {
    schemas: openApiSchemas,
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

type SchemaName = keyof typeof openApiSchemas;
type ProblemResponseName = keyof typeof problemResponses;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
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

function problemResponse(description: string) {
  return {
    description,
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ApiProblem' },
      },
    },
  } as const;
}

function pathParameter(name: string, description: string) {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: jsonSchema(z.uuid(), 'input'),
  } as const;
}
