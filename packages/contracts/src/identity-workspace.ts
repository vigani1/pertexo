import type { z } from 'zod';

import { apiProblemSchema } from './errors/api-problem.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
} from './openapi-primitives.js';
import {
  accessibleWorkspacesQuerySchema,
  accessibleWorkspacesResponseSchema,
  oidcAuthorizationCodeSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  oidcStateSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceIdentifierSchema,
  workspaceLifecycleOperationIdentifierSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  userProfileResponseSchema,
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
  UserProfileResponse: jsonSchema(userProfileResponseSchema, 'output'),
  WorkspaceResponse: jsonSchema(workspaceResponseSchema, 'output'),
  WorkspaceMembersResponse: jsonSchema(
    workspaceMembersResponseSchema,
    'output',
  ),
  WorkspaceMemberRoleChangeRequest: jsonSchema(
    workspaceMemberRoleChangeRequestSchema,
    'input',
  ),
  WorkspaceMemberRoleChangeResponse: jsonSchema(
    workspaceMemberRoleChangeResponseSchema,
    'output',
  ),
  AccessibleWorkspacesResponse: jsonSchema(
    accessibleWorkspacesResponseSchema,
    'output',
  ),
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
  RateLimited: problemResponse('Rate limited'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const identityWorkspaceOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Identity and Workspace API',
    version: '1.0.0',
  },
  paths: {
    '/v1/users/me': {
      get: {
        operationId: 'getCurrentUserProfile',
        security: [{ cookieSession: [] }],
        responses: {
          '200': jsonResponse('Current user profile', 'UserProfileResponse'),
          '401': responseReference('Unauthenticated'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
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
          '303': {
            description: 'Browser session established; return to the web app',
            headers: {
              Location: {
                description: 'Configured same-origin application landing path',
                schema: { type: 'string', pattern: '^/(?!/)' },
              },
            },
          },
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
      get: {
        operationId: 'listAccessibleWorkspaces',
        security: [{ cookieSession: [] }],
        parameters: [
          queryParameter('limit', accessibleWorkspacesQuerySchema.shape.limit),
          queryParameter('after', accessibleWorkspacesQuerySchema.shape.after),
        ],
        responses: {
          '200': jsonResponse(
            'Workspaces accessible to the current user',
            'AccessibleWorkspacesResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
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
    '/v1/workspaces/{workspaceId}/members': {
      get: {
        operationId: 'listWorkspaceMembers',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter(),
          queryParameter('limit', workspaceMembersQuerySchema.shape.limit),
          queryParameter('after', workspaceMembersQuerySchema.shape.after),
        ],
        responses: {
          '200': jsonResponse('Workspace members', 'WorkspaceMembersResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/members/{userId}/role': {
      post: {
        operationId: 'changeWorkspaceMemberRole',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter(),
          memberPathParameter(),
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('WorkspaceMemberRoleChangeRequest'),
        responses: {
          '200': jsonResponse(
            'Workspace member role change receipt',
            'WorkspaceMemberRoleChangeResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': problemResponse('Workspace member not found'),
          '409': responseReference('Conflict'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
  },
  components: authenticatedComponents(schemas, problemResponses),
});

function queryParameter(
  name: 'code' | 'state' | 'limit' | 'after',
  schema: z.ZodType,
) {
  return {
    name,
    in: 'query',
    required: name === 'code' || name === 'state',
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

function memberPathParameter() {
  return {
    name: 'userId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  } as const;
}

function lifecycleParameters() {
  return [
    pathParameter(),
    csrfHeaderParameter(),
    idempotencyHeaderParameter(),
  ] as const;
}
