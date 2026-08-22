import { z } from 'zod';

import { apiProblemSchema } from './errors/api-problem.js';
import {
  connectionCreateRequestSchema,
  connectionIdentifierSchema,
  connectionResponseSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
} from './http/connections.js';

export * from './http/connections.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ConnectionCreateRequest: jsonSchema(connectionCreateRequestSchema, 'input'),
  ConnectionResponse: jsonSchema(connectionResponseSchema, 'output'),
  ConnectionRotateSecretRequest: jsonSchema(
    connectionRotateSecretRequestSchema,
    'input',
  ),
  ConnectionTestRequest: jsonSchema(connectionTestRequestSchema, 'input'),
  ConnectionTestResponse: jsonSchema(connectionTestResponseSchema, 'output'),
});

export const connectionsClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas,
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Connection not found'),
  Conflict: problemResponse('Request conflict'),
  ReauthorizationRequired: problemResponse('Reauthorization required'),
  ServiceUnavailable: problemResponse('Key or provider service unavailable'),
  Unexpected: problemResponse('Unexpected server error'),
});

const workspaceParameter = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;
const connectionParameter = {
  name: 'connectionId',
  in: 'path',
  required: true,
  schema: jsonSchema(connectionIdentifierSchema, 'input'),
} as const;
const csrfParameter = {
  name: 'x-csrf-token',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 16, maxLength: 256 },
} as const;
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: '^[\\x21-\\x7e]+$',
  },
} as const;

export const connectionsOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Connections API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/connections': {
      post: {
        operationId: 'createConnection',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, csrfParameter, idempotencyParameter],
        requestBody: jsonRequest('ConnectionCreateRequest'),
        responses: {
          '201': jsonResponse('Connection created', 'ConnectionResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/secret': {
      put: {
        operationId: 'rotateConnectionSecret',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('ConnectionRotateSecretRequest'),
        responses: {
          '200': jsonResponse(
            'Connection secret rotated',
            'ConnectionResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}': {
      delete: {
        operationId: 'revokeConnection',
        security: [{ cookieSession: [] }],
        parameters: [workspaceParameter, connectionParameter, csrfParameter],
        responses: {
          '200': jsonResponse('Connection revoked', 'ConnectionResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/connections/{connectionId}/test': {
      post: {
        operationId: 'testConnection',
        security: [{ cookieSession: [] }],
        parameters: [
          workspaceParameter,
          connectionParameter,
          csrfParameter,
          idempotencyParameter,
        ],
        requestBody: jsonRequest('ConnectionTestRequest'),
        responses: {
          '200': jsonResponse(
            'Connection test completed',
            'ConnectionTestResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('NotFound'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
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

function responseReference(name: ProblemResponseName) {
  return { $ref: `#/components/responses/${name}` } as const;
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
      'application/problem+json': { schema: schemaReference('ApiProblem') },
    },
  } as const;
}
