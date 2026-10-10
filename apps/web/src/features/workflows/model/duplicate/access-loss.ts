import type { QueryClient } from '@tanstack/react-query';
import {
  assertSessionIdentity,
  isSessionIdentityChangedError,
} from '@/features/auth/session-identity.public';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';

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
  return watchWorkspaceReadDenial(
    queryClient,
    userId,
    workspaceId,
    ({ key, error }) =>
      isCurrent() &&
      (error.status === 401 ||
        key[0] === 'workflows' ||
        (key[0] === 'workflow' && key[1] === workflowId)),
    retire,
  );
}
