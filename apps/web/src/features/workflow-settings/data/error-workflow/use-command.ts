import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { useRef } from 'react';
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
    Readonly<{ body: WorkflowErrorSettingsRequest; key: string }> | undefined
  >(undefined);
  const sending = useRef(false);
  const queryKey = errorWorkflowKey(userId, workspaceId, workflowId);
  const mutation = useMutation({
    mutationFn: (request: NonNullable<typeof intent.current>) =>
      putErrorWorkflow({
        client: apiClient,
        workspaceId,
        workflowId,
        body: request.body,
        key: request.key,
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
    const request = intent.current ?? { body, key: crypto.randomUUID() };
    intent.current = request;
    sending.current = true;
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
  const problem = errorMessage();
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
