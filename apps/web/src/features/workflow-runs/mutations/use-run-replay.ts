import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import { normalizeRunIntent, type RunIntent } from '../model/run-intent';
import { replayWorkflowRun } from '../workflow-runs.api';
import { workflowRunKeys } from '../workflow-runs.queries';

type RunReplayAttempt = Readonly<{
  intent: RunIntent;
  normalizedIntent: string;
  idempotencyKey: string;
}>;

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
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [retryAvailable, setRetryAvailable] = useState(false);
  const attempt = useRef<RunReplayAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('run-replay');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) owner.current = undefined;
    };
  }, [apiClient, sourceRunId, workflowVersionId, workspaceId]);

  async function submit(command: RunReplayAttempt) {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined || pending) return false;
    setPending(true);
    setError(undefined);
    setRetryAvailable(false);
    attempt.current = command;
    try {
      const response = await replayWorkflowRun(
        apiClient,
        workspaceId,
        sourceRunId,
        {
          workflowVersionId,
          value: command.intent.value,
          ...(command.intent.deadlineAt === undefined
            ? {}
            : { deadlineAt: command.intent.deadlineAt }),
          idempotencyKey: command.idempotencyKey,
        },
      );
      if (owner.current !== submissionOwner) return false;
      attempt.current = undefined;
      await queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
      if (owner.current !== submissionOwner) return false;
      onRunAccepted(response.run.id);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      const uncertain = isUncertainOutcome(cause);
      if (!uncertain) attempt.current = undefined;
      setRetryAvailable(uncertain);
      setError(runReplayError(cause));
      return false;
    } finally {
      if (owner.current === submissionOwner) setPending(false);
    }
  }

  function startNew(intent: RunIntent) {
    if (pending || retryAvailable) return Promise.resolve(false);
    return submit({
      intent,
      normalizedIntent: normalizeRunIntent(intent),
      idempotencyKey: crypto.randomUUID(),
    });
  }

  function retry(intent: RunIntent) {
    const current = attempt.current;
    if (pending || current === undefined) return Promise.resolve(false);
    if (normalizeRunIntent(intent) !== current.normalizedIntent) {
      setError(
        'The values changed since the unconfirmed replay. Restore them to retry it, or close this dialog to start over.',
      );
      return Promise.resolve(false);
    }
    return submit(current);
  }

  function dismiss() {
    if (pending) return;
    attempt.current = undefined;
    setRetryAvailable(false);
    setError(undefined);
  }

  return { dismiss, error, pending, retry, retryAvailable, startNew };
}

function runReplayError(error: unknown): string {
  if (isUncertainOutcome(error))
    return 'We couldn’t confirm whether the replay started. Retry with the same values; Pertexo won’t start it twice.';
  if (isApiError(error) && error.status === 409)
    return 'This replay clashes with an earlier one. Close this dialog and start a new replay.';
  return describeCommandError(error, 'replaying this run');
}
