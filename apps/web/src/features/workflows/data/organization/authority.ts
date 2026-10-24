import type { QueryClient } from '@tanstack/react-query';
import {
  accessibleWorkspaceSchema,
  type AccessibleWorkspace,
} from '@pertexo/contracts';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session/identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { workflowOrganizationKeys } from './queries';

export type RequiredRole = 'member' | 'editor' | 'admin';

export function allowed(
  workspace: AccessibleWorkspace | undefined,
  role: RequiredRole,
) {
  return (
    workspace?.status === 'active' &&
    workspace.capabilities.includes('workflow:read') &&
    (role === 'member' ||
      workspace.role === 'owner' ||
      workspace.role === 'admin' ||
      (role === 'editor' && workspace.role === 'builder'))
  );
}

export function accessLost(error: unknown) {
  return (
    isSessionIdentityChangedError(error) ||
    (isApiError(error) && [401, 403, 404].includes(error.status ?? 0))
  );
}

export function clearOrganizationQueries(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
) {
  const queryKey = workflowOrganizationKeys.scope(userId, workspaceId);
  void queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
}

export async function verifyCurrentAuthority({
  apiClient,
  userId,
  workspaceId,
  requiredRole,
  signal,
  current,
  retire,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  requiredRole: RequiredRole;
  signal: AbortSignal;
  current: () => boolean;
  retire: () => void;
}>) {
  await assertSessionIdentity(apiClient, userId, signal);
  if (!current()) return false;
  const accessible = await getAllAccessibleWorkspaces(apiClient, signal);
  if (!current()) return false;
  if (
    !allowed(
      accessible.find((item) => item.id === workspaceId),
      requiredRole,
    )
  ) {
    retire();
    return false;
  }
  return true;
}

export function observeAuthority({
  queryClient,
  userId,
  workspaceId,
  requiredRole,
  current,
  retire,
}: Readonly<{
  queryClient: QueryClient;
  userId: string;
  workspaceId: string;
  requiredRole: RequiredRole;
  current: () => boolean;
  retire: () => void;
}>) {
  return queryClient.getQueryCache().subscribe((event) => {
    if (!current() || event.type !== 'updated') return;
    const { inScope, relatedRead, discovery, identity } = authorityReadScope(
      event.query.queryKey as readonly unknown[],
      userId,
      workspaceId,
    );
    // An earlier scoped observer may synchronously cancel/remove this query.
    // Preserve the event's immutable failure instead of its reverted state.
    const failure: unknown =
      event.action.type === 'error'
        ? event.action.error
        : event.query.state.error;
    const requiredReadAccessLost =
      (relatedRead || discovery || identity) && accessLost(failure);
    if (requiredReadAccessLost) retire();
    else {
      const sessionLost =
        inScope && isApiError(failure) && failure.status === 401;
      if (sessionLost) retire();
    }
    const discoveryRevoked =
      discovery &&
      event.query.state.status === 'success' &&
      discoveryLostAccess(event.query.state.data, workspaceId, requiredRole);
    if (discoveryRevoked) retire();
    const data: unknown = event.query.state.data;
    const identityChanged = identity && changedIdentity(data, userId);
    if (identityChanged) retire();
  });
}

function authorityReadScope(
  key: readonly unknown[],
  userId: string,
  workspaceId: string,
) {
  const inScope =
    key[0] === 'identity' &&
    key[1] === userId &&
    key[2] === 'workspace' &&
    key[3] === workspaceId;
  const relatedRead =
    inScope && (key[4] === 'workflows' || key[4] === 'workflow-organization');
  const discovery =
    key[0] === 'identity' &&
    key[1] === userId &&
    key[2] === 'accessible-workspaces';
  const identity = key[0] === 'identity' && key[1] === 'current-user';

  return { inScope, relatedRead, discovery, identity };
}

function discoveryLostAccess(
  data: unknown,
  workspaceId: string,
  requiredRole: RequiredRole,
): boolean {
  const parsed = accessibleWorkspaceSchema.array().safeParse(data);
  return (
    parsed.success &&
    !allowed(
      parsed.data.find((item) => item.id === workspaceId),
      requiredRole,
    )
  );
}

function changedIdentity(data: unknown, userId: string): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof data.id === 'string' &&
    data.id !== userId
  );
}
