import { useQueryClient } from '@tanstack/react-query';
import type { WorkspaceLifecycleChangeResponse } from '@pertexo/contracts';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import {
  reactivateWorkspace,
  requestWorkspaceDeletion,
  restoreWorkspaceDeletion,
} from '../../workspace-lifecycle.api';
import { accessibleWorkspacesQueryOptions } from '../../workspaces.queries';

type LifecycleIntent =
  | Readonly<{ command: 'request-deletion'; reason: string }>
  | Readonly<{ command: 'restore' | 'reactivate' }>;

export function useWorkspaceLifecycleCommand({
  apiClient,
  workspaceId,
  userId,
  onCompleted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  userId: string;
  onCompleted: (
    change: WorkspaceLifecycleChangeResponse['change'],
  ) => void | Promise<void>;
}>) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (intent: LifecycleIntent, key) => {
      switch (intent.command) {
        case 'request-deletion':
          return requestWorkspaceDeletion(apiClient, workspaceId, {
            reason: intent.reason,
            idempotencyKey: key,
          });
        case 'restore':
          return restoreWorkspaceDeletion(apiClient, workspaceId, key);
        case 'reactivate':
          return reactivateWorkspace(apiClient, workspaceId, key);
      }
    },
    refresh: () =>
      cache.invalidateQueries({
        queryKey: accessibleWorkspacesQueryOptions(apiClient, userId).queryKey,
      }),
  });
  async function start(intent: LifecycleIntent) {
    if (mutation.isPending) return false;
    try {
      let completion: Promise<void> | undefined;
      await mutation.mutateAsync(intent, {
        onSuccess: (result) => {
          completion = Promise.resolve(onCompleted(result.change));
        },
      });
      if (completion === undefined) return false;
      await completion;
      return true;
    } catch {
      return false;
    }
  }
  let error: string | undefined;
  if (mutation.isError)
    error =
      isApiError(mutation.error) && mutation.error.status === 409
        ? 'The workspace changed meanwhile. Reload the page to see where it stands.'
        : lowEffectError(mutation.error, 'changing this workspace');
  return { start, pending: mutation.isPending, reset: mutation.reset, error };
}
