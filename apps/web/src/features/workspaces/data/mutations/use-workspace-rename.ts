import {
  CONFLICT,
  RELOAD_FAILED,
  NOT_CAUGHT_UP,
  classifyFailure,
  type RenameError,
} from '../../model/rename-feedback';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  WorkspaceRenameRequest,
  WorkspaceRenameResponse,
} from '@pertexo/contracts';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import type { ApiClient } from '@/lib/api/client';
import {
  accessibleWorkspacesQueryOptions,
  workspaceKeys,
} from '../workspaces.queries';
import { renameWorkspace } from '../workspaces.api';

export function useWorkspaceRename({
  apiClient,
  userId,
  workspaceId,
  onChanged,
  onReloaded,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  onChanged: (name: string) => void;
  onReloaded: () => void;
  onAccessLost: () => void;
}>) {
  const cache = useQueryClient();
  const refresh = () =>
    cache.invalidateQueries({ queryKey: workspaceKeys.accessible(userId) });
  const mutation = useLowEffectMutation({
    send: (input: Readonly<{ body: WorkspaceRenameRequest }>, key) =>
      renameWorkspace(apiClient, workspaceId, {
        ...input,
        idempotencyKey: key,
      }),
    refresh,
  });
  const discovery = useMutation({
    mutationFn: async (receipt: WorkspaceRenameResponse | undefined) => {
      await refresh();
      const rows = await cache.query(
        accessibleWorkspacesQueryOptions(apiClient, userId),
      );
      if (
        receipt !== undefined &&
        !rows.some(
          (row) =>
            row.id === workspaceId &&
            row.revision >= receipt.workspace.revision,
        )
      )
        throw new Error(NOT_CAUGHT_UP.message);
    },
  });
  async function refreshAccepted() {
    try {
      await discovery.mutateAsync(mutation.data, {
        onSuccess: () => {
          if (mutation.data !== undefined)
            onChanged(mutation.data.workspace.name);
          else onReloaded();
        },
      });
      return true;
    } catch {
      return false;
    }
  }
  async function start(input: Readonly<{ body: WorkspaceRenameRequest }>) {
    if (mutation.isPending || discovery.isPending) return false;
    discovery.reset();
    try {
      const receipt = await mutation.mutateAsync(input);
      await discovery.mutateAsync(receipt, {
        onSuccess: () => {
          onChanged(receipt.workspace.name);
        },
      });
      return true;
    } catch (cause) {
      const failure = classifyFailure(cause);
      if (failure.kind === 'signed-out') {
        await cache.cancelQueries({ queryKey: ['identity'] });
        cache.removeQueries({ queryKey: ['identity'] });
        onAccessLost();
      } else if (failure.kind === 'forbidden') onAccessLost();
      if (failure.kind === 'rejected' && failure.error === CONFLICT)
        void discovery
          .mutateAsync(undefined, { onSuccess: onReloaded })
          .catch(() => undefined);
      return false;
    }
  }
  const failure = mutation.isError
    ? classifyFailure(mutation.error)
    : undefined;
  let error: RenameError | undefined;
  if (discovery.isError)
    error = mutation.data === undefined ? RELOAD_FAILED : NOT_CAUGHT_UP;
  else if (failure?.kind === 'rejected') error = failure.error;
  else if (mutation.isError)
    error = {
      kind: 'other',
      message: lowEffectError(mutation.error, 'renaming the workspace'),
    };
  return {
    start,
    pending: mutation.isPending,
    accepted: mutation.isSuccess && !discovery.isSuccess,
    refreshPending: discovery.isPending,
    refresh: refreshAccepted,
    reloadLatest: refreshAccepted,
    error,
    clearError: () => {
      mutation.reset();
      discovery.reset();
    },
  };
}
