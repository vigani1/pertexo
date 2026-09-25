import {
  accessibleWorkspacesResponseSchema,
  type AccessibleWorkspacesResponse,
  type WorkspaceCreateRequest,
  type WorkspaceResponse,
  type WorkspaceRenameRequest,
  type WorkspaceRenameResponse,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceLifecycleOperationResponseSchema,
  type WorkspaceLifecycleOperationResponse,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  type WorkspaceMembersResponse,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  type WorkspaceMemberRoleChangeResponse,
  workspaceMemberRemovalRequestSchema,
  workspaceMemberRemovalResponseSchema,
  type WorkspaceMemberRemovalResponse,
  workspaceInvitationCommandRequestSchema,
  workspaceInvitationCommandResponseSchema,
  workspaceInvitationCreateRequestSchema,
  workspaceInvitationsQuerySchema,
  workspaceInvitationsResponseSchema,
  type WorkspaceInvitationCommandResponse,
  type WorkspaceInvitationsResponse,
  workspaceResponseSchema,
  workspaceRenameRequestSchema,
  workspaceRenameResponseSchema,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { collectPages, searchParams } from '@/lib/api/pagination';

export function createWorkspace(
  apiClient: ApiClient,
  input: Readonly<{
    body: WorkspaceCreateRequest;
    idempotencyKey: string;
  }>,
): Promise<WorkspaceResponse> {
  return apiClient.request({
    path: '/v1/workspaces',
    method: 'POST',
    body: workspaceCreateRequestSchema.parse(input.body),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => workspaceResponseSchema.parse(value),
    },
  });
}

export function renameWorkspace(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    body: WorkspaceRenameRequest;
    idempotencyKey: string;
  }>,
): Promise<WorkspaceRenameResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    method: 'PATCH',
    body: workspaceRenameRequestSchema.parse(input.body),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => workspaceRenameResponseSchema.parse(value),
    },
  });
}

function getAccessibleWorkspacesPage(
  apiClient: ApiClient,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<AccessibleWorkspacesResponse> {
  const query = new URLSearchParams({ limit: '100' });
  if (input.after !== undefined) query.set('after', input.after);
  return apiClient.request({
    path: `/v1/workspaces?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => accessibleWorkspacesResponseSchema.parse(value),
    },
  });
}

export function getWorkspaceInvitationsPage(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<WorkspaceInvitationsResponse> {
  const parsed = workspaceInvitationsQuerySchema.parse({
    limit: 50,
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations?${searchParams(parsed)}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workspaceInvitationsResponseSchema.parse(value),
    },
  });
}

export function createWorkspaceInvitation(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    email: string;
    role: 'admin' | 'builder' | 'operator' | 'viewer';
    idempotencyKey: string;
  }>,
): Promise<WorkspaceInvitationCommandResponse> {
  return invitationCommand(
    apiClient,
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    workspaceInvitationCreateRequestSchema.parse({
      email: input.email,
      role: input.role,
    }),
    input.idempotencyKey,
  );
}

export function changeWorkspaceInvitation(
  apiClient: ApiClient,
  workspaceId: string,
  invitationId: string,
  operation: 'resend' | 'revoke',
  input: Readonly<{ expectedRevision: number; idempotencyKey: string }>,
): Promise<WorkspaceInvitationCommandResponse> {
  return invitationCommand(
    apiClient,
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}/${operation}`,
    workspaceInvitationCommandRequestSchema.parse({
      expectedRevision: input.expectedRevision,
    }),
    input.idempotencyKey,
  );
}

function invitationCommand(
  apiClient: ApiClient,
  path: `/v1${string}`,
  body: unknown,
  idempotencyKey: string,
): Promise<WorkspaceInvitationCommandResponse> {
  return apiClient.request({
    path,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
    response: {
      kind: 'json',
      decode: (value): WorkspaceInvitationCommandResponse =>
        workspaceInvitationCommandResponseSchema.parse(value),
    },
  });
}

/** One existing-member command: a POST to the member's verb with its key. */
function sendMemberCommand<Receipt>(
  apiClient: ApiClient,
  command: Readonly<{
    workspaceId: string;
    userId: string;
    verb: 'role' | 'remove';
    body: unknown;
    idempotencyKey: string;
    decode: (value: unknown) => Receipt;
  }>,
): Promise<Receipt> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(command.workspaceId)}/members/${encodeURIComponent(command.userId)}/${command.verb}`,
    method: 'POST',
    body: command.body,
    headers: { 'Idempotency-Key': command.idempotencyKey },
    response: { kind: 'json', decode: command.decode },
  });
}

export function changeWorkspaceMemberRole(
  apiClient: ApiClient,
  workspaceId: string,
  userId: string,
  input: Readonly<{
    role: 'admin' | 'builder' | 'operator' | 'viewer';
    expectedRoleRevision: number;
    idempotencyKey: string;
  }>,
): Promise<WorkspaceMemberRoleChangeResponse> {
  return sendMemberCommand(apiClient, {
    workspaceId,
    userId,
    verb: 'role',
    body: workspaceMemberRoleChangeRequestSchema.parse({
      role: input.role,
      expectedRoleRevision: input.expectedRoleRevision,
    }),
    idempotencyKey: input.idempotencyKey,
    decode: (value) => workspaceMemberRoleChangeResponseSchema.parse(value),
  });
}

export function removeWorkspaceMember(
  apiClient: ApiClient,
  workspaceId: string,
  userId: string,
  input: Readonly<{ expectedRoleRevision: number; idempotencyKey: string }>,
): Promise<WorkspaceMemberRemovalResponse> {
  return sendMemberCommand(apiClient, {
    workspaceId,
    userId,
    verb: 'remove',
    body: workspaceMemberRemovalRequestSchema.parse({
      expectedRoleRevision: input.expectedRoleRevision,
    }),
    idempotencyKey: input.idempotencyKey,
    decode: (value) => workspaceMemberRemovalResponseSchema.parse(value),
  });
}

export function getWorkspaceMembersPage(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<WorkspaceMembersResponse> {
  const parsed = workspaceMembersQuerySchema.parse({
    limit: 50,
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/members?${searchParams(parsed)}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workspaceMembersResponseSchema.parse(value),
    },
  });
}

export function requestWorkspaceDeletion(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{ reason: string; idempotencyKey: string }>,
): Promise<WorkspaceLifecycleOperationResponse> {
  const body = workspaceDeletionRequestSchema.parse({ reason: input.reason });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/deletion`,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => decodeLifecycleOperation(value, workspaceId),
    },
  });
}

export function restoreWorkspaceDeletion(
  apiClient: ApiClient,
  workspaceId: string,
  idempotencyKey: string,
): Promise<WorkspaceLifecycleOperationResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/deletion`,
    method: 'DELETE',
    headers: { 'Idempotency-Key': idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => decodeLifecycleOperation(value, workspaceId),
    },
  });
}

export function getWorkspaceLifecycleOperation(
  apiClient: ApiClient,
  workspaceId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<WorkspaceLifecycleOperationResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/lifecycle-operations/${encodeURIComponent(operationId)}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => {
        const operation = decodeLifecycleOperation(value, workspaceId);
        if (operation.id !== operationId)
          throw new Error('Lifecycle operation identifier mismatch.');
        return operation;
      },
    },
  });
}

function decodeLifecycleOperation(value: unknown, workspaceId: string) {
  const operation = workspaceLifecycleOperationResponseSchema.parse(value);
  if (operation.workspaceId !== workspaceId)
    throw new Error('Lifecycle operation workspace mismatch.');
  return operation;
}

export async function getAllAccessibleWorkspaces(
  apiClient: ApiClient,
  signal?: AbortSignal,
) {
  const items = await collectPages(
    (after) =>
      getAccessibleWorkspacesPage(apiClient, {
        ...(after === undefined ? {} : { after }),
        ...(signal === undefined ? {} : { signal }),
      }),
    // Every accessible workspace is needed to route; no page bound.
    { read: 'Workspace discovery', maxPages: Number.POSITIVE_INFINITY, signal },
  );
  return Object.freeze(items);
}
