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
  accountSecurityRevokeOthersResponseSchema,
  accountSecurityPasswordChangeRequestSchema,
  accountSecurityPasswordChangeResponseSchema,
  accountSecurityPasswordSetupRequestSchema,
  accountSecurityPasswordSetupResponseSchema,
  accountSecurityResponseSchema,
  accountSecurityMethodUnlinkRequestSchema,
  accountSecurityMethodUnlinkResponseSchema,
  accountSecurityLinkStartRequestSchema,
  accountSecurityLinkStartResponseSchema,
  legacyMethodMigrationStartRequestSchema,
  legacyMethodMigrationStartResponseSchema,
  accountSecuritySessionRevokeRequestSchema,
  accountSecuritySessionRevokeResponseSchema,
  accountSecuritySessionsResponseSchema,
  authenticationCapabilitiesResponseSchema,
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceOidcRequestSchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  oidcAuthorizationCodeSchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  oidcStateSchema,
  workspaceCreateRequestSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
  workspaceDeletionRequestSchema,
  workspaceIdentifierSchema,
  workspaceLifecycleOperationIdentifierSchema,
  workspaceLifecycleOperationResponseSchema,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationIdentifierSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationsQuerySchema,
  workspaceInvitationsResponseSchema,
  userProfileResponseSchema,
  workspaceResponseSchema,
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
  WorkspaceInvitationCreateRequest: jsonSchema(
    workspaceInvitationCreateRequestSchema,
    'input',
  ),
  WorkspaceInvitationCommandRequest: jsonSchema(
    workspaceInvitationCommandRequestSchema,
    'input',
  ),
  WorkspaceInvitationCommandResponse: jsonSchema(
    workspaceInvitationCommandResponseSchema,
    'output',
  ),
  WorkspaceInvitationsResponse: jsonSchema(
    workspaceInvitationsResponseSchema,
    'output',
  ),
  InvitationAcceptanceResolveRequest: jsonSchema(
    invitationAcceptanceResolveRequestSchema,
    'input',
  ),
  InvitationAcceptanceOidcRequest: jsonSchema(
    invitationAcceptanceOidcRequestSchema,
    'input',
  ),
  InvitationAcceptanceCompleteRequest: jsonSchema(
    invitationAcceptanceCompleteRequestSchema,
    'input',
  ),
  InvitationAcceptanceJourney: jsonSchema(
    invitationAcceptanceJourneySchema,
    'output',
  ),
  InvitationAcceptanceReceipt: jsonSchema(
    invitationAcceptanceReceiptSchema,
    'output',
  ),
  AccessibleWorkspacesResponse: jsonSchema(
    accessibleWorkspacesResponseSchema,
    'output',
  ),
  AuthenticationCapabilitiesResponse: jsonSchema(
    authenticationCapabilitiesResponseSchema,
    'output',
  ),
  AccountSecuritySessionsResponse: jsonSchema(
    accountSecuritySessionsResponseSchema,
    'output',
  ),
  AccountSecuritySessionRevokeRequest: jsonSchema(
    accountSecuritySessionRevokeRequestSchema,
    'input',
  ),
  AccountSecuritySessionRevokeResponse: jsonSchema(
    accountSecuritySessionRevokeResponseSchema,
    'output',
  ),
  AccountSecurityRevokeOthersResponse: jsonSchema(
    accountSecurityRevokeOthersResponseSchema,
    'output',
  ),
  AccountSecurityResponse: jsonSchema(accountSecurityResponseSchema, 'output'),
  AccountSecurityPasswordChangeRequest: jsonSchema(
    accountSecurityPasswordChangeRequestSchema,
    'input',
  ),
  AccountSecurityPasswordChangeResponse: jsonSchema(
    accountSecurityPasswordChangeResponseSchema,
    'output',
  ),
  AccountSecurityPasswordSetupRequest: jsonSchema(
    accountSecurityPasswordSetupRequestSchema,
    'input',
  ),
  AccountSecurityPasswordSetupResponse: jsonSchema(
    accountSecurityPasswordSetupResponseSchema,
    'output',
  ),
  AccountSecurityMethodUnlinkRequest: jsonSchema(
    accountSecurityMethodUnlinkRequestSchema,
    'input',
  ),
  AccountSecurityMethodUnlinkResponse: jsonSchema(
    accountSecurityMethodUnlinkResponseSchema,
    'output',
  ),
  AccountSecurityLinkStartRequest: jsonSchema(
    accountSecurityLinkStartRequestSchema,
    'input',
  ),
  AccountSecurityLinkStartResponse: jsonSchema(
    accountSecurityLinkStartResponseSchema,
    'output',
  ),
  LegacyMethodMigrationStartRequest: jsonSchema(
    legacyMethodMigrationStartRequestSchema,
    'input',
  ),
  LegacyMethodMigrationStartResponse: jsonSchema(
    legacyMethodMigrationStartResponseSchema,
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
    '/v1/auth/capabilities': {
      get: {
        operationId: 'getAuthenticationCapabilities',
        responses: {
          '200': jsonResponse(
            'Configured public authentication methods',
            'AuthenticationCapabilitiesResponse',
          ),
          '500': responseReference('Unexpected'),
        },
      },
    },
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
    '/v1/auth/account-security/sessions': {
      get: {
        operationId: 'listAccountSecuritySessions',
        security: [{ cookieSession: [] }],
        responses: {
          '200': jsonResponse(
            'Current user session summaries',
            'AccountSecuritySessionsResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/account-security': {
      get: {
        operationId: 'getAccountSecurity',
        security: [{ cookieSession: [] }],
        responses: {
          '200': jsonResponse(
            'Current authentication methods',
            'AccountSecurityResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/account-security/password/change': {
      post: {
        operationId: 'changeAccountPassword',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        requestBody: jsonRequest('AccountSecurityPasswordChangeRequest'),
        responses: {
          '200': jsonResponse(
            'Password changed',
            'AccountSecurityPasswordChangeResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/account-security/password/setup': {
      post: {
        operationId: 'setAccountPassword',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        requestBody: jsonRequest('AccountSecurityPasswordSetupRequest'),
        responses: {
          '200': jsonResponse(
            'Password configured',
            'AccountSecurityPasswordSetupResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/account-security/methods/unlink': {
      post: {
        operationId: 'unlinkAccountSecurityMethod',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        requestBody: jsonRequest('AccountSecurityMethodUnlinkRequest'),
        responses: {
          '200': jsonResponse(
            'Authentication method unlinked',
            'AccountSecurityMethodUnlinkResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('Forbidden'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/account-security/methods/link/start': {
      post: {
        operationId: 'startAccountMethodLink',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        requestBody: jsonRequest('AccountSecurityLinkStartRequest'),
        responses: {
          '200': jsonResponse('Provider authorization started', 'AccountSecurityLinkStartResponse'),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '404': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '503': responseReference('ServiceUnavailable'),
        },
      },
    },
    '/v1/auth/legacy-migration/start': {
      post: {
        operationId: 'startLegacyMethodMigration',
        requestBody: jsonRequest('LegacyMethodMigrationStartRequest'),
        responses: {
          '200': jsonResponse('Legacy method proof started', 'LegacyMethodMigrationStartResponse'),
          '400': responseReference('BadRequest'),
          '404': responseReference('Forbidden'),
          '503': responseReference('ServiceUnavailable'),
        },
      },
    },
    '/v1/auth/account-security/sessions/revoke': {
      post: {
        operationId: 'revokeAccountSecuritySession',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        requestBody: jsonRequest('AccountSecuritySessionRevokeRequest'),
        responses: {
          '200': jsonResponse(
            'Session revocation result',
            'AccountSecuritySessionRevokeResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/auth/account-security/sessions/revoke-others': {
      post: {
        operationId: 'revokeOtherAccountSecuritySessions',
        security: [{ cookieSession: [] }],
        parameters: [csrfHeaderParameter()],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: false },
            },
          },
        },
        responses: {
          '200': jsonResponse(
            'Other-session revocation result',
            'AccountSecurityRevokeOthersResponse',
          ),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
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
    '/v1/workspaces/{workspaceId}/invitations': {
      get: {
        operationId: 'listWorkspaceInvitations',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter(),
          queryParameter('limit', workspaceInvitationsQuerySchema.shape.limit),
          queryParameter('after', workspaceInvitationsQuerySchema.shape.after),
        ],
        responses: {
          '200': jsonResponse(
            'Workspace invitations',
            'WorkspaceInvitationsResponse',
          ),
          '400': responseReference('BadRequest'),
          '401': responseReference('Unauthenticated'),
          '403': responseReference('Forbidden'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
      post: {
        operationId: 'createWorkspaceInvitation',
        security: [{ cookieSession: [] }],
        parameters: [
          pathParameter(),
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('WorkspaceInvitationCreateRequest'),
        responses: invitationCommandResponses('Invitation accepted'),
      },
    },
    '/v1/workspaces/{workspaceId}/invitations/{invitationId}/resend': {
      post: {
        operationId: 'resendWorkspaceInvitation',
        security: [{ cookieSession: [] }],
        parameters: invitationCommandParameters(),
        requestBody: jsonRequest('WorkspaceInvitationCommandRequest'),
        responses: invitationCommandResponses('Invitation resend accepted'),
      },
    },
    '/v1/workspaces/{workspaceId}/invitations/{invitationId}/revoke': {
      post: {
        operationId: 'revokeWorkspaceInvitation',
        security: [{ cookieSession: [] }],
        parameters: invitationCommandParameters(),
        requestBody: jsonRequest('WorkspaceInvitationCommandRequest'),
        responses: invitationCommandResponses('Invitation revoked'),
      },
    },
    '/v1/invitation-acceptance/resolve': {
      post: {
        operationId: 'resolveInvitationAcceptance',
        parameters: [invitationRequestHeaderParameter()],
        requestBody: jsonRequest('InvitationAcceptanceResolveRequest'),
        responses: {
          '201': jsonResponse(
            'Browser-bound invitation journey',
            'InvitationAcceptanceJourney',
          ),
          '400': responseReference('BadRequest'),
          '403': responseReference('Forbidden'),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/invitation-acceptance': {
      get: {
        operationId: 'getInvitationAcceptance',
        security: [{ invitationBinding: [] }],
        responses: {
          '200': jsonResponse(
            'Current invitation journey',
            'InvitationAcceptanceJourney',
          ),
          '429': responseReference('RateLimited'),
          '500': responseReference('Unexpected'),
        },
      },
      delete: {
        operationId: 'abandonInvitationAcceptance',
        security: [{ invitationBinding: [] }],
        parameters: [invitationCsrfHeaderParameter()],
        responses: {
          '204': { description: 'Invitation journey abandoned' },
          '403': responseReference('Forbidden'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/invitation-acceptance/oidc': {
      post: {
        operationId: 'startInvitationAcceptanceOidc',
        security: [{ invitationBinding: [] }],
        parameters: [invitationCsrfHeaderParameter()],
        requestBody: jsonRequest('InvitationAcceptanceOidcRequest'),
        responses: {
          '200': jsonResponse(
            'OIDC authorization transaction',
            'OidcStartResponse',
          ),
          '403': responseReference('Forbidden'),
          '409': responseReference('Conflict'),
          '500': responseReference('Unexpected'),
        },
      },
    },
    '/v1/invitation-acceptance/complete': {
      post: {
        operationId: 'completeInvitationAcceptance',
        security: [{ cookieSession: [], invitationBinding: [] }],
        parameters: [
          csrfHeaderParameter(),
          invitationCsrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('InvitationAcceptanceCompleteRequest'),
        responses: {
          '200': jsonResponse(
            'Invitation acceptance receipt',
            'InvitationAcceptanceReceipt',
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

function invitationPathParameter() {
  return {
    name: 'invitationId',
    in: 'path',
    required: true,
    schema: jsonSchema(workspaceInvitationIdentifierSchema, 'input'),
  } as const;
}

function invitationRequestHeaderParameter() {
  return {
    name: 'X-Pertexo-Invitation-Request',
    in: 'header',
    required: true,
    schema: { type: 'string', const: 'resolve' },
  } as const;
}

function invitationCsrfHeaderParameter() {
  return {
    name: 'X-Invitation-Csrf-Token',
    in: 'header',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 512 },
  } as const;
}

function invitationCommandParameters() {
  return [
    pathParameter(),
    invitationPathParameter(),
    csrfHeaderParameter(),
    idempotencyHeaderParameter(),
  ] as const;
}

function invitationCommandResponses(description: string) {
  return {
    '202': jsonResponse(description, 'WorkspaceInvitationCommandResponse'),
    '400': responseReference('BadRequest'),
    '401': responseReference('Unauthenticated'),
    '403': responseReference('Forbidden'),
    '404': problemResponse('Invitation unavailable'),
    '409': responseReference('Conflict'),
    '429': responseReference('RateLimited'),
    '503': responseReference('ServiceUnavailable'),
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
