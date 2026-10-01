import type { QueryClient } from '@tanstack/react-query';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session-identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';

export function isDuplicateAccessLoss(error: unknown) {
  return (
    isSessionIdentityChangedError(error) ||
    (isApiError(error) && [401, 403, 404].includes(error.status ?? 0))
  );
}

export async function verifyDuplicateAuthority(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  signal: AbortSignal,
) {
  await assertSessionIdentity(apiClient, userId, signal);
  // Never authorize an exact retry from cached membership.
  const workspace = (await getAllAccessibleWorkspaces(apiClient, signal)).find(
    (item) => item.id === workspaceId,
  );
  return (
    workspace?.status === 'active' &&
    workspace.capabilities.includes('workflow:create') &&
    workspace.capabilities.includes('workflow:read')
  );
}

export function observeDuplicateAccessLoss(
  queryClient: QueryClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  isCurrent: () => boolean,
  retire: () => void,
) {
  return queryClient.getQueryCache().subscribe((event) => {
    if (!isCurrent() || event.type !== 'updated') return;
    const key = event.query.queryKey as readonly unknown[];
    const error: unknown = event.query.state.error;
    const inWorkspace =
      key[0] === 'identity' &&
      key[1] === userId &&
      key[2] === 'workspace' &&
      key[3] === workspaceId;
    const sourceRead =
      inWorkspace &&
      (key[4] === 'workflows' ||
        (key[4] === 'workflow' && key[5] === workflowId));
    if (
      isApiError(error) &&
      ((inWorkspace && error.status === 401) ||
        (sourceRead && [403, 404].includes(error.status ?? 0)))
    )
      retire();
  });
}
