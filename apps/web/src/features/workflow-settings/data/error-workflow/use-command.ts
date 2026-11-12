import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowErrorSettingsRequest } from '@pertexo/contracts';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { putErrorWorkflow } from './error-workflow.api';
import { errorWorkflowKey } from './error-workflow.queries';

export function useErrorWorkflowCommand(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (body: WorkflowErrorSettingsRequest, key) =>
      putErrorWorkflow({
        client: apiClient,
        workspaceId,
        workflowId,
        body,
        key,
      }),
    refresh: () =>
      cache.invalidateQueries({
        queryKey: errorWorkflowKey(userId, workspaceId, workflowId),
      }),
  });
  async function send(body: WorkflowErrorSettingsRequest) {
    if (mutation.isPending) return false;
    try {
      await mutation.mutateAsync(body);
      return true;
    } catch {
      return false;
    }
  }
  const code = isApiError(mutation.error)
    ? mutation.error.problem?.code
    : undefined;
  const conflict = code === 'workflow.error_policy_conflict';
  let problem: string | undefined;
  if (mutation.isError) {
    if (conflict)
      problem =
        'This changed in another session. Review the refreshed setting and save again.';
    else if (code === 'workflow.error_target_unavailable')
      problem =
        'Choose an active workflow published with When a workflow fails.';
    else problem = lowEffectError(mutation.error, 'saving the error workflow');
  }
  return { send, pending: mutation.isPending, problem, conflict };
}
