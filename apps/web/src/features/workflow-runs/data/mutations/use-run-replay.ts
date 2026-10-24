import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import {
  isUnconfirmedRunCommand,
  runAdmissionError,
} from '../../model/commands/run';
import {
  normalizeRunIntent,
  type RunIntent,
} from '../../model/commands/run-intent';
import { replayWorkflowRun } from '../workflow-runs.api';
import { workflowRunKeys } from '../query-cache';
import { useRetainedSubmission } from './use-retained-submission';
export function useRunReplay({
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
  return useRetainedSubmission<RunIntent>({
    apiClient,
    userId,
    workspaceId,
    sourceRunId,
    workflowVersionId,
    normalize: normalizeRunIntent,
    send: async (intent, key) =>
      (
        await replayWorkflowRun(apiClient, workspaceId, sourceRunId, {
          workflowVersionId,
          value: intent.value,
          ...(intent.deadlineAt === undefined
            ? {}
            : { deadlineAt: intent.deadlineAt }),
          idempotencyKey: key,
        })
      ).run.id,
    describeError: runReplayError,
    onAccepted: (runId) => {
      void client.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
      onRunAccepted(runId);
    },
  });
}

function runReplayError(error: unknown): string {
  const admissionError = runAdmissionError(error);
  if (admissionError !== undefined) return admissionError;
  if (isUnconfirmedRunCommand(error))
    return 'We couldn’t confirm whether the replay started. Retry the same request within 24 hours to check acceptance without starting it twice.';
  if (isApiError(error) && error.problem?.code === 'form.required')
    return 'Form replays keep the exact original response. Open the workflow form to send new values.';
  if (
    isApiError(error) &&
    error.problem?.code === 'workflow.variable_snapshot_unavailable'
  )
    return 'This run’s workspace variables expired. Start a new run to use current values.';
  if (isApiError(error) && error.status === 409)
    return 'This replay clashes with an earlier one. Close this dialog and start a new replay.';
  return describeCommandError(error, 'replaying this run');
}
