import {
  accessibleWorkspacesResponseSchema,
  type AccessibleWorkspacesResponse,
  workspaceDeletionRequestSchema,
  workspaceLifecycleOperationResponseSchema,
  type WorkspaceLifecycleOperationResponse,
  workspaceMembersQuerySchema,
  workspaceMembersResponseSchema,
  type WorkspaceMembersResponse,
  workspaceMemberRoleChangeRequestSchema,
  workspaceMemberRoleChangeResponseSchema,
  type WorkspaceMemberRoleChangeResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';

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
  const body = workspaceMemberRoleChangeRequestSchema.parse({
    role: input.role,
    expectedRoleRevision: input.expectedRoleRevision,
  });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/role`,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => workspaceMemberRoleChangeResponseSchema.parse(value),
    },
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
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(parsed))
    query.set(name, String(value));

  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/members?${query.toString()}`,
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
  const items: AccessibleWorkspacesResponse['items'][number][] = [];
  const cursors = new Set<string>();
  let after: string | undefined;

  for (;;) {
    signal?.throwIfAborted();
    const page = await getAccessibleWorkspacesPage(apiClient, {
      ...(after === undefined ? {} : { after }),
      ...(signal === undefined ? {} : { signal }),
    });
    items.push(...page.items);
    if (page.nextCursor === null) return Object.freeze(items);
    if (cursors.has(page.nextCursor))
      throw new ApiError({
        kind: 'protocol',
        message: 'Workspace discovery returned an invalid cursor sequence.',
      });
    cursors.add(page.nextCursor);
    after = page.nextCursor;
  }
}
