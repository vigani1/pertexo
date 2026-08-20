import { z } from 'zod';

import {
  idempotencyKeySchema,
  oidcAuthorizationCodeSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  oidcStateSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceIdentifierSchema,
  workspaceResponseSchema,
} from './types.js';

const schemas = Object.freeze({
  OidcCallbackRequest: jsonSchema(oidcCallbackRequestSchema, 'input'),
  OidcStartResponse: jsonSchema(oidcStartResponseSchema, 'output'),
  WorkspaceCreateRequest: jsonSchema(workspaceCreateRequestSchema, 'input'),
  WorkspaceDeletionRequest: jsonSchema(workspaceDeletionRequestSchema, 'input'),
  WorkspaceResponse: jsonSchema(workspaceResponseSchema, 'output'),
});

/** Browser-safe schemas generated mechanically from the owning Zod contracts. */
export const identityWorkspaceClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas,
});

/** OpenAPI 3.1 projection of the Phase 1 public identity/workspace routes. */
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
        responses: { '204': { description: 'Browser session established' } },
      },
    },
    '/v1/auth/logout': {
      post: {
        operationId: 'logoutSession',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        responses: { '204': { description: 'Browser session revoked' } },
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
        },
      },
    },
    '/v1/workspaces/{workspaceId}/deletion': {
      post: {
        operationId: 'requestWorkspaceDeletion',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter('workspaceId'),
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('WorkspaceDeletionRequest'),
        responses: {
          '201': jsonResponse(
            'Workspace deletion requested',
            'WorkspaceResponse',
          ),
        },
      },
      delete: {
        operationId: 'restoreWorkspace',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter('workspaceId'),
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        responses: {
          '200': jsonResponse(
            'Workspace restored as suspended',
            'WorkspaceResponse',
          ),
        },
      },
    },
  },
  components: {
    schemas,
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

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
}

function schemaReference(name: SchemaName): Readonly<{ $ref: string }> {
  return { $ref: `#/components/schemas/${name}` };
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

function queryParameter(name: 'code' | 'state', schema: z.ZodType) {
  return {
    name,
    in: 'query',
    required: true,
    schema: jsonSchema(schema, 'input'),
  } as const;
}

function pathParameter(name: 'workspaceId') {
  return {
    name,
    in: 'path',
    required: true,
    schema: jsonSchema(workspaceIdentifierSchema, 'input'),
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
