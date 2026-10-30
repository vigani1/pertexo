import {
  RETRY_WINDOW_ENDED,
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkflowErrorSettingsRequest } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import { putErrorWorkflow } from './api';
import { errorWorkflowKey } from './queries';

export function useErrorWorkflowCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const cache = useQueryClient();
  const intent = useRef<
    (Readonly<{ body: WorkflowErrorSettingsRequest }> & CommandKey) | undefined
  >(undefined);
  const sending = useRef(false);
  const [windowEnded, setWindowEnded] = useState(false);
  const queryKey = errorWorkflowKey(userId, workspaceId, workflowId);
  const mutation = useMutation({
    mutationFn: (request: NonNullable<typeof intent.current>) =>
      putErrorWorkflow({
        client: apiClient,
        workspaceId,
        workflowId,
        body: request.body,
        key: request.idempotencyKey,
      }),
    onSuccess: () => {
      intent.current = undefined;
    },
    onError: async (error) => {
      if (!isUnconfirmedCommand(error)) intent.current = undefined;
      if (isApiError(error) && [401, 403, 404].includes(error.status ?? 0)) {
        await cache.cancelQueries({ queryKey });
        cache.removeQueries({ queryKey });
      }
    },
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey });
    },
  });
  async function send(body: WorkflowErrorSettingsRequest): Promise<boolean> {
    if (
      sending.current ||
      (intent.current !== undefined &&
        JSON.stringify(intent.current.body) !== JSON.stringify(body))
    )
      return false;
    if (intent.current !== undefined && !canResend(intent.current)) {
      intent.current = undefined;
      mutation.reset();
      setWindowEnded(true);
      return false;
    }
    const request = intent.current ?? { body, ...newCommandKey() };
    intent.current = request;
    sending.current = true;
    setWindowEnded(false);
    try {
      await mutation.mutateAsync(request);
      return true;
    } catch {
      return false;
    } finally {
      sending.current = false;
    }
  }
  const conflict =
    isApiError(mutation.error) &&
    mutation.error.problem?.code === 'workflow.error_policy_conflict';
  const unconfirmed = mutation.isError && isUnconfirmedCommand(mutation.error);
  function errorMessage(): string | undefined {
    if (!mutation.isError) return undefined;
    if (conflict)
      return 'This changed in another session. Review the refreshed setting and save again.';
    const targetUnavailable =
      isApiError(mutation.error) &&
      mutation.error.problem?.code === 'workflow.error_target_unavailable';
    if (targetUnavailable)
      return 'Choose an active workflow published with When a workflow fails.';
    if (unconfirmed)
      return 'The change could not be confirmed. Retry the same change before editing it.';
    return describeCommandError(mutation.error, 'saving the error workflow');
  }
  const problem = windowEnded ? RETRY_WINDOW_ENDED : errorMessage();
  return {
    send,
    pending: mutation.isPending,
    problem,
    unconfirmed,
    conflict,
    retry: () =>
      intent.current === undefined
        ? Promise.resolve(false)
        : send(intent.current.body),
  };
}
