import { apiProblemSchema } from './errors/api-problem.js';
import {
  authenticationContractPaths,
  authenticationContractSchemas,
} from './authentication-contract.js';
import {
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
} from './http/authentication.js';
import {
  authenticatedComponents,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  queryParameter,
  responseReference,
} from './openapi-primitives.js';
import {
  workspaceInvitationContractPaths,
  workspaceInvitationContractSchemas,
} from './workspace-invitations-contract.js';
import {
  accessibleWorkspacesQuerySchema,
  accessibleWorkspacesResponseSchema,
  workspaceCreateRequestSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceDeletionRequestSchema,
  workspaceIdentifierSchema,
  workspaceLifecycleOperationIdentifierSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  workspaceMemberRemovalRequestSchema,
  workspaceMemberRemovalResponseSchema,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  userProfileResponseSchema,
  userProfileUpdateRequestSchema,
  userProfileUpdateResponseSchema,
  workspaceResponseSchema,
  workspaceLeaveRequestSchema,
  workspaceLeaveResponseSchema,
  workspaceMemberStatusRequestSchema,
  workspaceMemberStatusResponseSchema,
  workspaceOwnershipTransferRequestSchema,
  workspaceOwnershipTransferResponseSchema,
} from './http/identity-workspace.js';

export * from './http/identity-workspace.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  OidcCallbackRequest: jsonSchema(oidcCallbackRequestSchema, 'input'),
  OidcStartResponse: jsonSchema(oidcStartResponseSchema, 'output'),
  WorkspaceCreateRequest: jsonSchema(workspaceCreateRequestSchema, 'input'),
  WorkspaceRenameRequest: jsonSchema(workspaceRenameRequestSchema, 'input'),
  WorkspaceRenameResponse: jsonSchema(workspaceRenameResponseSchema, 'output'),
  WorkspaceDeletionRequest: jsonSchema(workspaceDeletionRequestSchema, 'input'),
  WorkspaceLifecycleOperationResponse: jsonSchema(
    workspaceLifecycleOperationResponseSchema,
    'output',
  ),
  UserProfileResponse: jsonSchema(userProfileResponseSchema, 'output'),
  UserProfileUpdateRequest: jsonSchema(userProfileUpdateRequestSchema, 'input'),
  UserProfileUpdateResponse: jsonSchema(
    userProfileUpdateResponseSchema,
    'output',
  ),
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
  WorkspaceMemberRemovalRequest: jsonSchema(
    workspaceMemberRemovalRequestSchema,
    'input',
  ),
  WorkspaceMemberRemovalResponse: jsonSchema(
    workspaceMemberRemovalResponseSchema,
    'output',
  ),
  WorkspaceLeaveRequest: jsonSchema(workspaceLeaveRequestSchema, 'input'),
  WorkspaceLeaveResponse: jsonSchema(workspaceLeaveResponseSchema, 'output'),
  WorkspaceMemberStatusRequest: jsonSchema(
    workspaceMemberStatusRequestSchema,
    'input',
  ),
  WorkspaceMemberStatusResponse: jsonSchema(
    workspaceMemberStatusResponseSchema,
    'output',
  ),
  WorkspaceOwnershipTransferRequest: jsonSchema(
    workspaceOwnershipTransferRequestSchema,
    'input',
  ),
  WorkspaceOwnershipTransferResponse: jsonSchema(
    workspaceOwnershipTransferResponseSchema,
    'output',
  ),
  ...workspaceInvitationContractSchemas,
  AccessibleWorkspacesResponse: jsonSchema(
    accessibleWorkspacesResponseSchema,
    'output',
  ),
  ...authenticationContractSchemas,
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
    ...authenticationContractPaths,
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
    '/v1/workspaces/{workspaceId}': {
      patch: {
        operationId: 'renameWorkspace',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter(),
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('WorkspaceRenameRequest'),
        responses: {
          '200': jsonResponse(
            'Workspace display-name change receipt',
            'WorkspaceRenameResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '412': problemResponse('Workspace revision changed'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/members/{userId}/role': {
      post: memberCommandOperation(
        'changeWorkspaceMemberRole',
        'WorkspaceMemberRoleChangeRequest',
        memberCommandResponses(
          'Workspace member role change receipt',
          'WorkspaceMemberRoleChangeResponse',
        ),
      ),
    },
    '/v1/workspaces/{workspaceId}/members/{userId}/remove': {
      post: memberCommandOperation(
        'removeWorkspaceMember',
        'WorkspaceMemberRemovalRequest',
        memberCommandResponses(
          'Workspace member removal receipt',
          'WorkspaceMemberRemovalResponse',
        ),
      ),
    },
    '/v1/workspaces/{workspaceId}/members/{userId}/suspend': {
      post: memberCommandOperation(
        'suspendWorkspaceMember',
        'WorkspaceMemberStatusRequest',
        memberCommandResponses(
          'Workspace member suspension receipt',
          'WorkspaceMemberStatusResponse',
        ),
      ),
    },
    '/v1/workspaces/{workspaceId}/members/{userId}/reactivate': {
      post: memberCommandOperation(
        'reactivateWorkspaceMember',
        'WorkspaceMemberStatusRequest',
        memberCommandResponses(
          'Workspace member reactivation receipt',
          'WorkspaceMemberStatusResponse',
        ),
      ),
    },
    '/v1/workspaces/{workspaceId}/members/{userId}/transfer-ownership': {
      post: memberCommandOperation(
        'transferWorkspaceOwnership',
        'WorkspaceOwnershipTransferRequest',
        memberCommandResponses(
          'Workspace ownership transfer receipt',
          'WorkspaceOwnershipTransferResponse',
        ),
      ),
    },
    '/v1/workspaces/{workspaceId}/leave': {
      post: {
        operationId: 'leaveWorkspace',
        security: [{ cookieSession: [] }],
        parameters: lifecycleParameters(),
        requestBody: jsonRequest('WorkspaceLeaveRequest'),
        responses: {
          '200': jsonResponse(
            'Workspace departure receipt',
            'WorkspaceLeaveResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    ...workspaceInvitationContractPaths,
  },
  components: {
    ...authenticatedComponents(schemas, problemResponses),
    securitySchemes: {
      ...authenticatedComponents(schemas, problemResponses).securitySchemes,
      invitationBinding: {
        type: 'apiKey',
        in: 'cookie',
        name: 'pertexo_invitation_intent',
      },
    },
  },
});

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

/** A POST command on one existing member (ADR 037, 042 and 047). */
function memberCommandOperation(
  operationId: string,
  request: string,
  responses: ReturnType<typeof memberCommandResponses>,
) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      pathParameter(),
      memberPathParameter(),
      csrfHeaderParameter(),
      idempotencyHeaderParameter(),
    ],
    requestBody: jsonRequest(request),
    responses,
  } as const;
}

function memberCommandResponses(description: string, schema: string) {
  return {
    '200': jsonResponse(description, schema),
    '400': responseReference('BadRequest'),
    '401': responseReference('Unauthenticated'),
    '403': responseReference('Forbidden'),
    '404': problemResponse('Workspace member not found'),
    '409': responseReference('Conflict'),
    '429': responseReference('RateLimited'),
    '500': responseReference('Unexpected'),
  } as const;
}

function lifecycleParameters() {
  return [
    pathParameter(),
    csrfHeaderParameter(),
    idempotencyHeaderParameter(),
  ] as const;
}
