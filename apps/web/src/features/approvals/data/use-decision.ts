import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PendingTaskDecisionRequest } from '@pertexo/contracts';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import { decideTask, type TaskScope } from './tasks.api';
import { taskKeys, taskQueryOptions } from './tasks.queries';
export function useDecision(scope: TaskScope, taskId: string) {
  const cache = useQueryClient();
  const intent = useRef<
    Readonly<{ body: PendingTaskDecisionRequest; key: string }> | undefined
  >(undefined);
  const busy = useRef(false);
  const mutation = useMutation({
    mutationFn: (command: NonNullable<typeof intent.current>) =>
      decideTask(scope, taskId, command.body, command.key),
    retry: false,
    onSuccess: (result) => {
      intent.current = undefined;
      cache.setQueryData(taskQueryOptions(scope, taskId).queryKey, {
        task: result.task,
      });
    },
    onError: async (error) => {
      if (!isUncertainOutcome(error)) intent.current = undefined;
      if (isApiError(error) && [401, 403, 404].includes(error.status ?? 0)) {
        await cache.cancelQueries({
          queryKey: taskKeys.scope(scope.userId, scope.workspaceId),
        });
        cache.removeQueries({
          queryKey: taskKeys.scope(scope.userId, scope.workspaceId),
        });
      }
    },
    onSettled: () =>
      cache.invalidateQueries({
        queryKey: taskKeys.scope(scope.userId, scope.workspaceId),
      }),
  });
  async function send(body: PendingTaskDecisionRequest) {
    if (busy.current) return;
    if (
      intent.current !== undefined &&
      JSON.stringify(intent.current.body) !== JSON.stringify(body)
    )
      return;
    const command = intent.current ?? {
      body: structuredClone(body),
      key: crypto.randomUUID(),
    };
    intent.current = command;
    busy.current = true;
    try {
      await mutation.mutateAsync(command);
    } catch {
      /* The form owns the single visible error. */
    } finally {
      busy.current = false;
    }
  }
  const uncertain = mutation.isError && isUncertainOutcome(mutation.error);
  return {
    send,
    pending: mutation.isPending,
    uncertain,
    error: mutation.isError
      ? uncertain
        ? 'We couldn’t confirm the decision. Retry the same decision to recover the result before changing anything.'
        : describeCommandError(mutation.error, 'recording this decision')
      : undefined,
    retry: () => {
      if (intent.current !== undefined) void send(intent.current.body);
    },
  };
}
