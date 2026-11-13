import { creationError } from '../../model/creation-feedback';
import type {
  AccessibleWorkspace,
  WorkspaceCreateRequest,
  WorkspaceResponse,
} from '@pertexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCreateCommand } from '@/lib/api/commands/use-create-command';
import { RETRY_WINDOW_ENDED } from '@/lib/api/commands/command-retry';
import { useState } from 'react';
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
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  onCreated: (workspace: AccessibleWorkspace) => void;
}>) {
  const cache = useQueryClient();
  const refresh = () =>
    cache.invalidateQueries({ queryKey: workspaceKeys.accessible(userId) });
  // A lost create keeps its key, so resending replays the receipt instead of
  // reporting the person's own new handle as taken.
  const command = useCreateCommand({
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
  const [windowEnded, setWindowEnded] = useState(false);
  async function start(input: Readonly<{ body: WorkspaceCreateRequest }>) {
    if (command.pending || command.data !== undefined) return false;
    discovery.reset();
    setWindowEnded(false);
    try {
      const receipt = await command.create(input);
      if (receipt === undefined) {
        // The person checks their workspaces first; the next create is new.
        command.startNewAttempt();
        setWindowEnded(true);
        return false;
      }
      await discovery.mutateAsync(receipt, { onSuccess: onCreated });
      return true;
    } catch {
      // The form shows the failure; an ended session pauses the page.
      return false;
    }
  }
  async function openCreated() {
    if (command.data === undefined || discovery.isPending) return false;
    try {
      await discovery.mutateAsync(command.data, { onSuccess: onCreated });
      return true;
    } catch {
      // The form shows the failure; an ended session pauses the page.
      return false;
    }
  }
  let error: ReturnType<typeof creationError> | undefined;
  if (discovery.isError)
    error = {
      message:
        'The workspace was created, but this page couldn’t refresh. Open workspace to try again.',
    };
  else if (windowEnded) error = { message: RETRY_WINDOW_ENDED };
  else if (command.uncertain)
    error = {
      message:
        'We couldn’t confirm whether the workspace was created. Creating it again unchanged is safe — it won’t make a second workspace.',
    };
  else if (command.failed) error = creationError(command.error);
  return {
    start,
    created: command.data !== undefined,
    pending: command.pending,
    locked: command.pending,
    refreshPending: discovery.isPending,
    refresh: openCreated,
    error,
    clearError: () => {
      setWindowEnded(false);
      if (command.failed) command.reset();
    },
  };
}
