import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/policy';

import {
  problemResponse,
  responseReference,
} from '../openapi-primitives.js';
import type { z } from 'zod';

import * as membership from '../../schemas/identity/membership.js';
import * as workspaces from '../../schemas/identity/workspaces.js';
import {
  defineRoute,
  named,
  type NamedSchema,
  type RouteAccess,
} from '../define.js';

const ROOT = '/v1/workspaces';
const ONE = `${ROOT}/{workspaceId}` as const;
const MEMBER = `${ONE}/members/{userId}` as const;

/** Workspace answers say "forbidden": the caller already knows the workspace. */
function session(
  name: AuthorizationCapability,
  statuses: WorkspaceStatusList,
): RouteAccess {
  return {
    auth: 'session',
    capabilities: [{ name, statuses, disclosure: 'forbidden' }],
  };
}
// Deletion can be undone until the workspace is purged.
const managing = session('workspace:manage', UNPURGED_WORKSPACE_STATUSES);
const managingMembers = session('member:manage', ACTIVE_WORKSPACE_STATUSES);
const signedIn: RouteAccess = { auth: 'session' };
const problems = (...statuses: readonly string[]) =>
  Object.fromEntries(statuses.map((status) => [status, PROBLEMS[status]]));
const PROBLEMS: Readonly<Record<string, unknown>> = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': problemResponse('Workspace member not found'),
  '409': responseReference('Conflict'),
  '412': problemResponse('Workspace revision changed'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
};
const lifecycleChange = (description: string) => ({
  status: 200,
  description,
  body: named(
    'WorkspaceLifecycleChangeResponse',
    workspaces.workspaceLifecycleChangeResponseSchema,
  ),
});

/** A command on one existing member (ADR 037, 042 and 047). */
function memberCommand<
  Body extends z.ZodType,
  const Path extends `/${string}`,
>({
  operationId,
  path,
  access,
  body,
  answer,
}: Readonly<{
  operationId: string;
  path: Path;
  access: RouteAccess;
  body: NamedSchema<Body>;
  answer: Readonly<{ description: string; body: NamedSchema }>;
}>) {
  return defineRoute({
    operationId,
    method: 'post',
    path,
    params: workspaces.workspaceMemberRoleParamsSchema,
    access,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body,
    success: { status: 200, ...answer },
    problems: problems('400', '401', '403', '404', '409', '429', '500'),
  });
}
const statusChange = named(
  'WorkspaceMemberStatusRequest',
  membership.workspaceMemberStatusRequestSchema,
);
const statusAnswer = named(
  'WorkspaceMemberStatusResponse',
  membership.workspaceMemberStatusResponseSchema,
);

export const workspaceRoutes = {
  list: defineRoute({
    operationId: 'listAccessibleWorkspaces',
    method: 'get',
    path: ROOT,
    query: workspaces.accessibleWorkspacesQuerySchema,
    access: signedIn,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Workspaces accessible to the current user',
      body: named(
        'AccessibleWorkspacesResponse',
        workspaces.accessibleWorkspacesResponseSchema,
      ),
    },
    problems: problems('400', '401', '429', '500'),
  }),
  create: defineRoute({
    operationId: 'createWorkspace',
    method: 'post',
    path: ROOT,
    access: signedIn,
    rateLimit: 'actor_mutation',
    idempotent: true,
    body: named(
      'WorkspaceCreateRequest',
      workspaces.workspaceCreateRequestSchema,
    ),
    success: {
      status: 201,
      description: 'Workspace created',
      body: named('WorkspaceResponse', workspaces.workspaceResponseSchema),
    },
    problems: problems('400', '401', '403', '409', '500'),
  }),
  requestDeletion: defineRoute({
    operationId: 'requestWorkspaceDeletion',
    method: 'post',
    path: `${ONE}/deletion`,
    params: workspaces.workspaceIdParamSchema,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'WorkspaceDeletionRequest',
      workspaces.workspaceDeletionRequestSchema,
    ),
    success: lifecycleChange('Workspace scheduled for deletion'),
    problems: problems('400', '401', '403', '409', '500'),
  }),
  restore: defineRoute({
    operationId: 'restoreWorkspace',
    method: 'delete',
    path: `${ONE}/deletion`,
    params: workspaces.workspaceIdParamSchema,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    success: lifecycleChange('Workspace restored'),
    problems: problems('400', '401', '403', '409', '500'),
  }),
  reactivate: defineRoute({
    operationId: 'reactivateWorkspace',
    method: 'post',
    path: `${ONE}/reactivate`,
    params: workspaces.workspaceIdParamSchema,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    success: lifecycleChange('Workspace reactivated'),
    problems: problems('400', '401', '403', '409', '500'),
  }),
  members: defineRoute({
    operationId: 'listWorkspaceMembers',
    method: 'get',
    path: `${ONE}/members`,
    params: workspaces.workspaceIdParamSchema,
    query: workspaces.workspaceMembersQuerySchema,
    access: session('member:read', BROWSABLE_WORKSPACE_STATUSES),
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Workspace members',
      body: named(
        'WorkspaceMembersResponse',
        workspaces.workspaceMembersResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '429', '500'),
  }),
  rename: defineRoute({
    operationId: 'renameWorkspace',
    method: 'patch',
    path: ONE,
    params: workspaces.workspaceIdParamSchema,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'WorkspaceRenameRequest',
      workspaces.workspaceRenameRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Workspace display-name change receipt',
      body: named(
        'WorkspaceRenameResponse',
        workspaces.workspaceRenameResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '409', '412', '429', '500'),
  }),
  changeRole: memberCommand({
    operationId: 'changeWorkspaceMemberRole',
    path: `${MEMBER}/role`,
    access: managingMembers,
    body: named(
      'WorkspaceMemberRoleChangeRequest',
      workspaces.workspaceMemberRoleChangeRequestSchema,
    ),
    answer: {
      description: 'Workspace member role change receipt',
      body: named(
        'WorkspaceMemberRoleChangeResponse',
        workspaces.workspaceMemberRoleChangeResponseSchema,
      ),
    },
  }),
  remove: memberCommand({
    operationId: 'removeWorkspaceMember',
    path: `${MEMBER}/remove`,
    access: managingMembers,
    body: named(
      'WorkspaceMemberRemovalRequest',
      workspaces.workspaceMemberRemovalRequestSchema,
    ),
    answer: {
      description: 'Workspace member removal receipt',
      body: named(
        'WorkspaceMemberRemovalResponse',
        workspaces.workspaceMemberRemovalResponseSchema,
      ),
    },
  }),
  suspend: memberCommand({
    operationId: 'suspendWorkspaceMember',
    path: `${MEMBER}/suspend`,
    access: managingMembers,
    body: statusChange,
    answer: {
      description: 'Workspace member suspension receipt',
      body: statusAnswer,
    },
  }),
  reactivateMember: memberCommand({
    operationId: 'reactivateWorkspaceMember',
    path: `${MEMBER}/reactivate`,
    access: managingMembers,
    body: statusChange,
    answer: {
      description: 'Workspace member reactivation receipt',
      body: statusAnswer,
    },
  }),
  /** Owner only, from a sign-in in the last five minutes. */
  transferOwnership: memberCommand({
    operationId: 'transferWorkspaceOwnership',
    path: `${MEMBER}/transfer-ownership`,
    access: managing,
    body: named(
      'WorkspaceOwnershipTransferRequest',
      membership.workspaceOwnershipTransferRequestSchema,
    ),
    answer: {
      description: 'Workspace ownership transfer receipt',
      body: named(
        'WorkspaceOwnershipTransferResponse',
        membership.workspaceOwnershipTransferResponseSchema,
      ),
    },
  }),
  leave: defineRoute({
    operationId: 'leaveWorkspace',
    method: 'post',
    path: `${ONE}/leave`,
    params: workspaces.workspaceIdParamSchema,
    access: session('workspace:read', ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named(
      'WorkspaceLeaveRequest',
      membership.workspaceLeaveRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Workspace departure receipt',
      body: named(
        'WorkspaceLeaveResponse',
        membership.workspaceLeaveResponseSchema,
      ),
    },
    problems: problems('400', '401', '403', '409', '429', '500'),
  }),
};
