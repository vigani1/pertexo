import { z } from 'zod';

import { apiProblemSchema } from './errors/api-problem.js';
import {
  idempotencyKeySchema,
  oidcAuthorizationCodeSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  oidcStateSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceIdentifierSchema,
  workspaceLifecycleOperationIdentifierSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceResponseSchema,
} from './http/identity-workspace.js';

export * from './http/identity-workspace.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  OidcCallbackRequest: jsonSchema(oidcCallbackRequestSchema, 'input'),
  OidcStartResponse: jsonSchema(oidcStartResponseSchema, 'output'),
  WorkspaceCreateRequest: jsonSchema(workspaceCreateRequestSchema, 'input'),
  WorkspaceDeletionRequest: jsonSchema(workspaceDeletionRequestSchema, 'input'),
  WorkspaceLifecycleOperationResponse: jsonSchema(
    workspaceLifecycleOperationResponseSchema,
    'output',
  ),
  WorkspaceResponse: jsonSchema(workspaceResponseSchema, 'output'),
});

export const identityWorkspaceClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas,
});

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  Conflict: problemResponse('Request conflict'),
  ServiceUnavailable: problemResponse('Upstream service unavailable'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const identityWorkspaceOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Identity and Workspace API',
    version: '1.0.0',
  },
  paths: {
    '/v1/auth/oidc/start': {
      get: {
        operationId: 'startOidcLogin',
        responses: {
          '200': jsonResponse(
            'OIDC authorization transaction',
            'OidcStartResponse',
          ),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/oidc/callback': {
      get: {
        operationId: 'completeOidcLogin',
        parameters: [
          queryParameter('code', oidcAuthorizationCodeSchema),
          queryParameter('state', oidcStateSchema),
        ],
        responses: {
          '204': { description: 'Browser session established' },
          '400': responseReference('BadRequest'),
          '503': responseReference('ServiceUnavailable'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/logout': {
      post: {
        operationId: 'logoutSession',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        responses: {
          '204': { description: 'Browser session revoked' },
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces': {
      post: {
        operationId: 'createWorkspace',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter(), idempotencyHeaderParameter()],
        requestBody: jsonRequest('WorkspaceCreateRequest'),
        responses: {
          '201': jsonResponse('Workspace created', 'WorkspaceResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/deletion': {
      post: {
        operationId: 'requestWorkspaceDeletion',
        security: [{ cookieSession: [] }],
        parameters: lifecycleParameters(),
        requestBody: jsonRequest('WorkspaceDeletionRequest'),
        responses: {
          '202': jsonResponse(
            'Workspace deletion operation accepted',
            'WorkspaceLifecycleOperationResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
      delete: {
        operationId: 'restoreWorkspace',
        security: [{ cookieSession: [] }],
        parameters: lifecycleParameters(),
        responses: {
          '202': jsonResponse(
            'Workspace restore operation accepted',
            'WorkspaceLifecycleOperationResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/lifecycle-operations/{operationId}': {
      get: {
        operationId: 'getWorkspaceLifecycleOperation',
        security: [{ cookieSession: [] }],
        parameters: [pathParameter(), lifecycleOperationPathParameter()],
        responses: {
          '200': jsonResponse(
            'Workspace lifecycle operation',
            'WorkspaceLifecycleOperationResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': problemResponse('Operation not found'),
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
      'application/problem+json': { schema: schemaReference('ApiProblem') },
    },
  } as const;
}

function queryParameter(name: 'code' | 'state', schema: z.ZodType) {
  return {
    name,
    in: 'query',
    required: true,
    schema: jsonSchema(schema, 'input'),
  } as const;
}

function pathParameter() {
  return {
    name: 'workspaceId',
    in: 'path',
    required: true,
    schema: jsonSchema(workspaceIdentifierSchema, 'input'),
  } as const;
}

function lifecycleOperationPathParameter() {
  return {
    name: 'operationId',
    in: 'path',
    required: true,
    schema: jsonSchema(workspaceLifecycleOperationIdentifierSchema, 'input'),
  } as const;
}

function csrfHeaderParameter() {
  return {
    name: 'x-csrf-token',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 16, maxLength: 256 },
  } as const;
}

function idempotencyHeaderParameter() {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: jsonSchema(idempotencyKeySchema, 'input'),
  } as const;
}

function lifecycleParameters() {
  return [
    pathParameter(),
    csrfHeaderParameter(),
    idempotencyHeaderParameter(),
  ] as const;
}
