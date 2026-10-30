import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import type { FormValues } from '@pertexo/workflow-model';
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PendingTaskDecisionRequest } from '@pertexo/contracts';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import { decideTask, submitTask, type TaskScope } from './tasks.api';
import { taskKeys, taskQueryOptions } from './tasks.queries';
type TaskResponse =
  PendingTaskDecisionRequest | Readonly<{ values: FormValues }>;
export function useTaskResponse(
  scope: TaskScope,
  taskId: string,
  /** Input requests send it so their uploaded files count. */
  session?: string,
) {
  const cache = useQueryClient();
  const intent = useRef<
    (Readonly<{ body: TaskResponse }> & CommandKey) | undefined
  >(undefined);
  const busy = useRef(false);
  const [windowEnded, setWindowEnded] = useState(false);
  const mutation = useMutation({
    mutationFn: (command: NonNullable<typeof intent.current>) =>
      'values' in command.body
        ? submitTask(scope, taskId, {
            values: command.body.values,
            key: command.idempotencyKey,
            session,
          })
        : decideTask(scope, taskId, command.body, command.idempotencyKey),
    retry: false,
    onSuccess: (result) => {
      intent.current = undefined;
      cache.setQueryData(taskQueryOptions(scope, taskId).queryKey, {
        task: result.task,
      });
    },
    onError: async (error) => {
      if (!isUnconfirmedCommand(error)) intent.current = undefined;
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
  async function send(body: TaskResponse) {
    if (busy.current) return;
    if (
      intent.current !== undefined &&
      JSON.stringify(intent.current.body) !== JSON.stringify(body)
    )
      return;
    if (intent.current !== undefined && !canResend(intent.current)) {
      intent.current = undefined;
      mutation.reset();
      setWindowEnded(true);
      return;
    }
    const command = intent.current ?? {
      body: structuredClone(body),
      ...newCommandKey(),
    };
    intent.current = command;
    busy.current = true;
    setWindowEnded(false);
    try {
      await mutation.mutateAsync(command);
    } catch {
      /* The form owns the single visible error. */
    } finally {
      busy.current = false;
    }
  }
  const responseName =
    mutation.variables !== undefined && 'values' in mutation.variables.body
      ? 'response'
      : 'decision';
  const uncertain = mutation.isError && isUnconfirmedCommand(mutation.error);
  function errorMessage(): string | undefined {
    if (windowEnded) return RETRY_WINDOW_ENDED;
    if (!mutation.isError) return undefined;
    if (uncertain)
      return `We couldn’t confirm the ${responseName}. Retry the same ${responseName} to recover the result before changing anything.`;
    return describeCommandError(
      mutation.error,
      `recording this ${responseName}`,
    );
  }
  return {
    send,
    pending: mutation.isPending,
    uncertain,
    error: errorMessage(),
    retry: () => {
      if (intent.current !== undefined) void send(intent.current.body);
    },
  };
}
