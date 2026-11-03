import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceStatusList,
} from '@pertexo/policy';

import {
  problemResponse,
  responseReference,
} from '../../openapi/primitives.js';
import * as workspaces from '../../schemas/identity/workspaces.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/invitations';

/** Invitations are read and changed by those who may manage members. */
function managing(statuses: WorkspaceStatusList): RouteAccess {
  return {
    auth: 'session',
    capabilities: [
      { name: 'member:manage', statuses, disclosure: 'forbidden' },
    ],
  };
}
const commandProblems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': problemResponse('Invitation unavailable'),
  '409': responseReference('Conflict'),
  '429': responseReference('RateLimited'),
  '503': responseReference('ServiceUnavailable'),
  '500': responseReference('Unexpected'),
};
const accepted = (description: string) => ({
  status: 202,
  description,
  body: named(
    'WorkspaceInvitationCommandResponse',
    workspaces.workspaceInvitationCommandResponseSchema,
  ),
});
const change = named(
  'WorkspaceInvitationCommandRequest',
  workspaces.workspaceInvitationCommandRequestSchema,
);

export const invitationRoutes = {
  list: defineRoute({
    operationId: 'listWorkspaceInvitations',
    method: 'get',
    path: ROOT,
    params: workspaces.workspaceIdParamSchema,
    query: workspaces.workspaceInvitationsQuerySchema,
    access: managing(BROWSABLE_WORKSPACE_STATUSES),
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Workspace invitations',
      body: named(
        'WorkspaceInvitationsResponse',
        workspaces.workspaceInvitationsResponseSchema,
      ),
    },
    problems: {
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
    },
  }),
  create: defineRoute({
    operationId: 'createWorkspaceInvitation',
    method: 'post',
    path: ROOT,
    params: workspaces.workspaceIdParamSchema,
    access: managing(ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'WorkspaceInvitationCreateRequest',
      workspaces.workspaceInvitationCreateRequestSchema,
    ),
    success: accepted('Invitation accepted'),
    problems: commandProblems,
  }),
  resend: defineRoute({
    operationId: 'resendWorkspaceInvitation',
    method: 'post',
    path: `${ROOT}/{invitationId}/resend`,
    params: workspaces.workspaceInvitationParamsSchema,
    access: managing(ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: change,
    success: accepted('Invitation resend accepted'),
    problems: commandProblems,
  }),
  revoke: defineRoute({
    operationId: 'revokeWorkspaceInvitation',
    method: 'post',
    path: `${ROOT}/{invitationId}/revoke`,
    params: workspaces.workspaceInvitationParamsSchema,
    access: managing(ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: change,
    success: accepted('Invitation revoked'),
    problems: commandProblems,
  }),
};
