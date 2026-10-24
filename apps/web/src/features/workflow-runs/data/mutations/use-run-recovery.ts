import type { WorkflowRecoveryRequest } from '@pertexo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { recoverRun } from '../recovery.api';
import { recoveryQueryOptions } from '../recovery.queries';
import { workflowRunKeys } from '../query-cache';
import { recoveryError } from '../../model/commands/recovery';
import { useRetainedSubmission } from './use-retained-submission';
export function useRunRecovery({
  apiClient,
  userId,
  workspaceId,
  sourceRunId,
  workflowVersionId,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  onRunAccepted: (runId: string) => void;
}>) {
  const client = useQueryClient();
  return useRetainedSubmission<WorkflowRecoveryRequest>({
    apiClient,
    userId,
    workspaceId,
    sourceRunId,
    workflowVersionId,
    normalize: (intent) =>
      JSON.stringify({
        workflowVersionId: intent.workflowVersionId,
        nodeRunId: intent.nodeRunId,
        deadlineAt: intent.deadlineAt ?? null,
        acknowledgePossibleEffects: intent.acknowledgePossibleEffects ?? false,
        acknowledgeUnknownOutcome: intent.acknowledgeUnknownOutcome ?? false,
      }),
    send: async (intent, key) => {
      try {
        return (
          await recoverRun({
            client: apiClient,
            workspaceId,
            runId: sourceRunId,
            body: intent,
            key,
          })
        ).run.id;
      } catch (cause) {
        void client.invalidateQueries({
          queryKey: recoveryQueryOptions(
            apiClient,
            userId,
            workspaceId,
            sourceRunId,
          ).queryKey,
        });
        throw cause;
      }
    },
    describeError: recoveryError,
    onAccepted: (runId) => {
      void client.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
      onRunAccepted(runId);
    },
  });
}
