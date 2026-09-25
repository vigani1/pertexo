import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  pathParameter,
  problemResponse,
  queryParameter,
  responseReference,
} from './openapi-primitives.js';
import {
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceOidcRequestSchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  invitationAcceptanceSessionRequestSchema,
  workspaceIdentifierSchema,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationIdentifierSchema,
  workspaceInvitationsQuerySchema,
  workspaceInvitationsResponseSchema,
} from './http/identity-workspace.js';

/**
 * Invitation management and browser-bound invitation acceptance operations
 * of the identity-workspace contract.
 */
export const workspaceInvitationContractSchemas = Object.freeze({
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
  InvitationAcceptanceSessionRequest: jsonSchema(
    invitationAcceptanceSessionRequestSchema,
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
});

export const workspaceInvitationContractPaths = Object.freeze({
  '/v1/workspaces/{workspaceId}/invitations': {
    get: {
      operationId: 'listWorkspaceInvitations',
      security: [{ cookieSession: [] }],
      parameters: [
        workspacePathParameter(),
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
        workspacePathParameter(),
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
  '/v1/invitation-acceptance/session': {
    post: {
      operationId: 'verifyInvitationAcceptanceSession',
      security: [{ cookieSession: [], invitationBinding: [] }],
      parameters: [csrfHeaderParameter(), invitationCsrfHeaderParameter()],
      requestBody: jsonRequest('InvitationAcceptanceSessionRequest'),
      responses: {
        '200': jsonResponse(
          'Invitation journey verified by a fresh sign-in',
          'InvitationAcceptanceJourney',
        ),
        '400': responseReference('BadRequest'),
        '401': responseReference('Unauthenticated'),
        '403': responseReference('Forbidden'),
        '404': problemResponse('Invitation unavailable'),
        '409': responseReference('Conflict'),
        '429': responseReference('RateLimited'),
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
});

function workspacePathParameter() {
  return pathParameter(
    'workspaceId',
    jsonSchema(workspaceIdentifierSchema, 'input'),
  );
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
    workspacePathParameter(),
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
