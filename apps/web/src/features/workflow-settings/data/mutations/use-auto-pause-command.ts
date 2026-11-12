import { useQueryClient } from '@tanstack/react-query';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { commandAutoPause, type AutoPauseCommand } from '../auto-pause.api';
import { autoPauseKeys } from '../auto-pause.queries';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/workspaces-queries.public';

export function useAutoPauseCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (command: AutoPauseCommand, key) =>
      commandAutoPause({ apiClient, workspaceId, workflowId, command, key }),
    refresh: (command) =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: autoPauseKeys.workflowRoot(userId, workspaceId),
        }),
        ...(command.kind === 'workspace'
          ? [
              cache.invalidateQueries({
                queryKey: autoPauseKeys.workspace(userId, workspaceId),
              }),
              cache.invalidateQueries({
                queryKey: accessibleWorkspacesQueryOptions(apiClient, userId)
                  .queryKey,
              }),
            ]
          : []),
      ]),
  });
  const conflict =
    isApiError(mutation.error) &&
    mutation.error.status === 409 &&
    [
      'workflow.pause_conflict',
      'workflow.auto_pause_settings_conflict',
      'workspace.auto_pause_settings_conflict',
    ].includes(mutation.error.problem?.code ?? '');
  async function send(command: AutoPauseCommand) {
    if (mutation.isPending) return false;
    try {
      await mutation.mutateAsync(command);
      return true;
    } catch {
      return false;
    }
  }
  const action =
    mutation.variables?.kind === 'resume'
      ? 'resuming triggers'
      : 'saving auto-pause settings';
  let problem: string | undefined;
  if (mutation.isError)
    problem = conflict
      ? 'This changed in another session. Your edits are kept. Review the refreshed settings, then save again.'
      : lowEffectError(mutation.error, action);
  return { send, pending: mutation.isPending, conflict, problem };
}
