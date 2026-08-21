import { z } from 'zod';

import { apiProblemSchema } from './errors/api-problem.js';
import { idempotencyKeySchema } from './http/identity-workspace.js';
import {
  lastRunEventIdHeaderSchema,
  workflowNodeRunSummarySchema,
  workflowRunCancelRequestSchema,
  workflowRunCancelResponseSchema,
  workflowRunEventSchema,
  workflowRunResponseSchema,
  workflowRunStartRequestSchema,
  workflowRunStartResponseSchema,
  workflowRunSummarySchema,
} from './http/workflow-runs.js';

export * from './http/workflow-runs.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  WorkflowRunStartRequest: jsonSchema(workflowRunStartRequestSchema, 'input'),
  WorkflowRunStartResponse: jsonSchema(
    workflowRunStartResponseSchema,
    'output',
  ),
  WorkflowRunSummary: jsonSchema(workflowRunSummarySchema, 'output'),
  WorkflowNodeRunSummary: jsonSchema(workflowNodeRunSummarySchema, 'output'),
  WorkflowRunResponse: jsonSchema(workflowRunResponseSchema, 'output'),
  WorkflowRunCancelRequest: jsonSchema(workflowRunCancelRequestSchema, 'input'),
  WorkflowRunCancelResponse: jsonSchema(
    workflowRunCancelResponseSchema,
    'output',
  ),
  WorkflowRunEvent: jsonSchema(workflowRunEventSchema, 'output'),
});

export const workflowRunsClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas,
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  UnprocessableEntity: problemResponse('Workflow is not executable'),
  Unexpected: problemResponse('Unexpected server error'),
});

const workspaceParameter = pathParameter('workspaceId', 'Workspace identifier');
const workflowParameter = pathParameter('workflowId', 'Workflow identifier');
const runParameter = pathParameter('runId', 'Workflow run identifier');
const csrfParameter = {
  name: 'x-csrf-token',
  in: 'header',
  required: true,
  schema: jsonSchema(z.string().min(16).max(512), 'input'),
} as const;
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: jsonSchema(idempotencyKeySchema, 'input'),
} as const;
const lastEventIdParameter = {
  name: 'Last-Event-ID',
  in: 'header',
  required: false,
  schema: jsonSchema(lastRunEventIdHeaderSchema, 'input'),
} as const;

export const workflowRunsOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Workflow Runs API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/runs': {
      post: {
        operationId: 'startWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          workflowParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('WorkflowRunStartRequest'),
        responses: {
          '202': jsonResponse(
            'Workflow run accepted',
            'WorkflowRunStartResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '422': responseReference('UnprocessableEntity'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}': {
      get: {
        operationId: 'getWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter],
        responses: {
          '200': jsonResponse('Workflow run', 'WorkflowRunResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/events': {
      get: {
        operationId: 'streamRunEvents',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter, lastEventIdParameter],
        responses: {
          '200': {
            description: 'Ordered workflow run event stream',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE frames containing WorkflowRunEvent data',
                },
              },
            },
          },
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/runs/{runId}/cancel': {
      post: {
        operationId: 'cancelWorkflowRun',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, runParameter, csrfParameter],
        requestBody: jsonRequest('WorkflowRunCancelRequest'),
        responses: {
          '200': jsonResponse(
            'Workflow run cancellation requested',
            'WorkflowRunCancelResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
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
