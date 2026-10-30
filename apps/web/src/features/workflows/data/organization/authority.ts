import {
  matchQuery,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
import {
  hasCapability,
  isAdministrativeRole,
  type Role,
} from '@pertexo/workflow-model';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session/identity.public';
import { currentUserQueryKey } from '@/features/auth/session/queries.public';
import {
  getAllAccessibleWorkspaces,
  workspaceKeys,
} from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/error';
import { isAccessLost } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { workspaceReadScope } from '@/lib/api/workspace-scope';
import { workflowKeys } from '../workflows.queries';
import { workflowOrganizationKeys } from './queries';

export type RequiredRole = 'member' | 'editor' | 'admin';

const ROLE_ALLOWED: Readonly<Record<RequiredRole, (role: Role) => boolean>> = {
  member: () => true,
  editor: (role) => hasCapability(role, 'workflow:update'),
  admin: isAdministrativeRole,
};

export function allowed(
  workspace: AccessibleWorkspace | undefined,
  role: RequiredRole,
) {
  return (
    workspace?.status === 'active' &&
    workspace.capabilities.includes('workflow:read') &&
    ROLE_ALLOWED[role](workspace.role)
  );
}

export function accessLost(error: unknown) {
  return isSessionIdentityChangedError(error) || isAccessLost(error);
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
      event.query,
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
    const { data, status } = event.query.state;
    const discoveryRevoked =
      discovery &&
      status === 'success' &&
      !allowed(
        (data as readonly AccessibleWorkspace[]).find(
          (item) => item.id === workspaceId,
        ),
        requiredRole,
      );
    if (discoveryRevoked) retire();
    const identityChanged =
      identity &&
      data !== undefined &&
      (data as UserProfileResponse).id !== userId;
    if (identityChanged) retire();
  });
}

function authorityReadScope(query: Query, userId: string, workspaceId: string) {
  const matches = (queryKey: QueryKey) => matchQuery({ queryKey }, query);
  return {
    inScope: matches(workspaceReadScope(userId, workspaceId)),
    relatedRead:
      matches(workflowKeys.scope(userId, workspaceId)) ||
      matches(workflowOrganizationKeys.scope(userId, workspaceId)),
    discovery: matches(workspaceKeys.accessible(userId)),
    identity: matches(currentUserQueryKey),
  };
}
