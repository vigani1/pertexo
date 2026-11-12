import { useQueryClient } from '@tanstack/react-query';
import {
  workflowConcurrencyRevisionConflictProblemSchema,
  workflowConcurrencyLimitExceededProblemSchema,
  type WorkflowConcurrencySettingsRequest,
} from '@pertexo/contracts';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import { isUnconfirmedCommand } from '@/lib/api/commands/command-retry';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import { putWorkflowConcurrency } from '../concurrency.api';
import { concurrencyKey } from '../concurrency.queries';
function commandProblem({
  error,
  revisionConflict,
}: Readonly<{ error: unknown; revisionConflict: boolean }>): string {
  if (revisionConflict)
    return 'This changed in another session. Your edits are kept. Review the refreshed limit, then save again.';
  if (isUnconfirmedCommand(error))
    return lowEffectError(error, 'saving concurrency settings');
  if (isApiError(error)) {
    const exceeded = workflowConcurrencyLimitExceededProblemSchema.safeParse(
      error.problemDetails,
    );
    if (exceeded.success)
      return `The workspace now allows at most ${String(exceeded.data.maximum)} active runs. Review the refreshed allowance and choose a lower limit.`;
    if (error.problem?.code === 'workflow.concurrency_limit_unavailable')
      return 'There is no active workspace execution allowance for setting a limit. You can still remove the workflow limit.';
  }
  return describeCommandError(error, 'saving concurrency settings');
}

export function useConcurrencyCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (body: WorkflowConcurrencySettingsRequest, key) =>
      putWorkflowConcurrency({
        client: apiClient,
        workspaceId,
        workflowId,
        body,
        key,
      }),
    refresh: () =>
      cache.invalidateQueries({
        queryKey: concurrencyKey(userId, workspaceId, workflowId),
      }),
  });
  const conflict =
    isApiError(mutation.error) &&
    mutation.error.kind === 'problem' &&
    workflowConcurrencyRevisionConflictProblemSchema.safeParse(
      mutation.error.problemDetails,
    ).success;
  async function send(body: WorkflowConcurrencySettingsRequest) {
    if (mutation.isPending) return false;
    try {
      await mutation.mutateAsync(body);
      return true;
    } catch {
      return false;
    }
  }
  return {
    send,
    pending: mutation.isPending,
    conflict,
    problem: mutation.isError
      ? commandProblem({ error: mutation.error, revisionConflict: conflict })
      : undefined,
  };
}
