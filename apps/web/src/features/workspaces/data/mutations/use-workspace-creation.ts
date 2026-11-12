import { creationError } from '../../model/creation-feedback';
import type {
  AccessibleWorkspace,
  WorkspaceCreateRequest,
  WorkspaceResponse,
} from '@pertexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import { isUnconfirmedCommand } from '@/lib/api/commands/command-retry';
import { isUnauthenticated } from '@/features/auth/session/identity.public';
import type { ApiClient } from '@/lib/api/client';
import {
  accessibleWorkspacesQueryOptions,
  workspaceKeys,
} from '../workspaces.queries';
import { createWorkspace } from '../workspaces.api';

export type WorkspaceCreationCommand = ReturnType<typeof useWorkspaceCreation>;

export function useWorkspaceCreation({
  apiClient,
  userId,
  onCreated,
  onSessionInvalidated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  onCreated: (workspace: AccessibleWorkspace) => void;
  onSessionInvalidated: () => void;
}>) {
  const cache = useQueryClient();
  const refresh = () =>
    cache.invalidateQueries({ queryKey: workspaceKeys.accessible(userId) });
  const mutation = useLowEffectMutation({
    send: (input: Readonly<{ body: WorkspaceCreateRequest }>, key) =>
      createWorkspace(apiClient, { ...input, idempotencyKey: key }),
    refresh,
  });
  const discovery = useMutation({
    mutationFn: async (receipt: WorkspaceResponse) => {
      await refresh();
      const rows = await cache.query(
        accessibleWorkspacesQueryOptions(apiClient, userId),
      );
      const created = rows.find((row) => row.id === receipt.id);
      if (created === undefined)
        throw new Error(
          'The workspace was created, but it isn’t visible in your list yet. Open it again after refreshing.',
        );
      return created;
    },
  });
  async function start(input: Readonly<{ body: WorkspaceCreateRequest }>) {
    if (mutation.isPending || mutation.isSuccess) return false;
    discovery.reset();
    try {
      const receipt = await mutation.mutateAsync(input);
      await discovery.mutateAsync(receipt, { onSuccess: onCreated });
      return true;
    } catch (cause) {
      if (isUnauthenticated(cause)) onSessionInvalidated();
      return false;
    }
  }
  async function openCreated() {
    if (mutation.data === undefined || discovery.isPending) return false;
    try {
      await discovery.mutateAsync(mutation.data, { onSuccess: onCreated });
      return true;
    } catch (cause) {
      if (isUnauthenticated(cause)) onSessionInvalidated();
      return false;
    }
  }
  let error: ReturnType<typeof creationError> | undefined;
  if (discovery.isError)
    error = {
      message:
        'The workspace was created, but this page couldn’t refresh. Open workspace to try again.',
    };
  else if (mutation.isError)
    error = isUnconfirmedCommand(mutation.error)
      ? { message: lowEffectError(mutation.error, 'creating the workspace') }
      : creationError(mutation.error);
  return {
    start,
    created: mutation.isSuccess,
    pending: mutation.isPending,
    locked: mutation.isPending,
    refreshPending: discovery.isPending,
    refresh: openCreated,
    error,
    clearError: () => {
      if (mutation.isError) mutation.reset();
    },
  };
}
