import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';
import { commandAutoPause, type AutoPauseCommand } from '../auto-pause.api';
import { autoPauseKeys } from '../auto-pause.queries';
import { settingsCommandError } from './settings-command';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';

/** Keep the entire request, including its original revision, for an exact retry. */
export function useAutoPauseCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const queryClient = useQueryClient();
  const attempt = useRef<
    Readonly<{ command: AutoPauseCommand; key: string }> | undefined
  >(undefined);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);

  async function send(command: AutoPauseCommand): Promise<boolean> {
    if (sending.current) return false;
    const current = attempt.current;
    if (
      current !== undefined &&
      JSON.stringify(current.command) !== JSON.stringify(command)
    )
      return false;
    const request = current ?? { command, key: crypto.randomUUID() };
    attempt.current = request;
    sending.current = true;
    setPending(true);
    setProblem(undefined);
    setConflict(false);
    try {
      await commandAutoPause(
        apiClient,
        workspaceId,
        workflowId,
        request.command,
        request.key,
      );
      attempt.current = undefined;
      setUnconfirmed(false);
      return true;
    } catch (cause) {
      const uncertain = isUncertainOutcome(cause);
      const revisionConflict =
        isApiError(cause) &&
        cause.kind === 'problem' &&
        cause.status === 409 &&
        (cause.problem?.code === 'workflow.pause_conflict' ||
          cause.problem?.code === 'workflow.auto_pause_settings_conflict' ||
          cause.problem?.code === 'workspace.auto_pause_settings_conflict');
      const action =
        command.kind === 'resume'
          ? 'resuming triggers'
          : 'saving auto-pause settings';
      if (!uncertain) attempt.current = undefined;
      setUnconfirmed(uncertain);
      setConflict(revisionConflict);
      setProblem(
        revisionConflict
          ? 'This changed in another session. Your edits are kept. Review the refreshed settings, then save again.'
          : uncertain
            ? settingsCommandError(cause, action)
            : describeCommandError(cause, action),
      );
      return false;
    } finally {
      // Receipts describe the originally accepted state, not current authority.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: autoPauseKeys.workflowRoot(userId, workspaceId),
        }),
        ...(command.kind === 'workspace'
          ? [
              queryClient.invalidateQueries({
                queryKey: autoPauseKeys.workspace(userId, workspaceId),
              }),
              queryClient.invalidateQueries({
                queryKey: accessibleWorkspacesQueryOptions(apiClient, userId)
                  .queryKey,
              }),
            ]
          : []),
      ]);
      sending.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    problem,
    unconfirmed,
    conflict,
    send,
    retry: () =>
      attempt.current === undefined
        ? Promise.resolve(false)
        : send(attempt.current.command),
  };
}
