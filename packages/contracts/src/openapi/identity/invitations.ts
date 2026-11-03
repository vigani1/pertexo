import { invitationRoutes } from '../../routes/identity/invitations.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
} from '../primitives.js';
import {
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  invitationAcceptanceSessionRequestSchema,
} from '../../schemas/identity/workspaces.js';

/**
 * Invitation management and browser-bound invitation acceptance operations
 * of the identity-workspace contract.
 */
export const workspaceInvitationContractSchemas = Object.freeze({
  ...routeSchemas(Object.values(invitationRoutes)),
  InvitationAcceptanceResolveRequest: jsonSchema(
    invitationAcceptanceResolveRequestSchema,
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
  ...routePaths(Object.values(invitationRoutes)),
  // Acceptance binds a browser with its own cookie and CSRF header, which no
  // declared access describes, so its operations stay written out.
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
