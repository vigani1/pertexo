import {
  workflowKeys,
  workflowOrganizationKeys,
} from '@/features/workflows/workflows-queries.public';
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
) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (command: AutoPauseCommand, key) =>
      commandAutoPause({ apiClient, workspaceId, command, key }),
    slotOf: ({ kind }) => kind,
    refresh: (command) =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: autoPauseKeys.workflowRoot(userId, workspaceId),
        }),
        ...(command.kind === 'resume' || command.kind === 'pause'
          ? [
              cache.invalidateQueries({
                queryKey: workflowKeys.detail(
                  userId,
                  workspaceId,
                  command.workflowId,
                ),
                exact: true,
              }),
              cache.invalidateQueries({
                queryKey: workflowKeys.lists(userId, workspaceId),
              }),
              cache.invalidateQueries({
                queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
              }),
            ]
          : []),
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
  let action = 'saving auto-pause settings';
  if (mutation.variables?.kind === 'pause') action = 'pausing triggers';
  if (mutation.variables?.kind === 'resume') action = 'resuming triggers';
  let problem: string | undefined;
  if (mutation.isError)
    problem = conflict
      ? 'This changed in another session. Your edits are kept. Review the refreshed settings, then save again.'
      : lowEffectError(mutation.error, action);
  return { send, pending: mutation.isPending, conflict, problem };
}
