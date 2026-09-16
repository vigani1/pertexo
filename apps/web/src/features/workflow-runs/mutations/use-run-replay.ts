import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { canonicalizeJson } from '@/lib/canonical-json';
import { replayWorkflowRun } from '../workflow-runs.api';

export type RunReplayIntent = Readonly<{
  value: unknown;
  deadlineAt?: string;
}>;

type RunReplayAttempt = Readonly<{
  intent: RunReplayIntent;
  normalizedIntent: string;
  idempotencyKey: string;
}>;

export function useRunReplay({
  apiClient,
  workspaceId,
  sourceRunId,
  workflowVersionId,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  onRunAccepted: (runId: string) => void;
}>) {
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
      onRunAccepted(response.run.id);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      const uncertain = isUncertain(cause);
      if (!uncertain) attempt.current = undefined;
      setRetryAvailable(uncertain);
      setError(runReplayError(cause));
      return false;
    } finally {
      if (owner.current === submissionOwner) setPending(false);
    }
  }

  function startNew(intent: RunReplayIntent) {
    if (pending || retryAvailable) return Promise.resolve(false);
    return submit({
      intent,
      normalizedIntent: normalizeReplayIntent(intent),
      idempotencyKey: crypto.randomUUID(),
    });
  }

  function retry(intent: RunReplayIntent) {
    const current = attempt.current;
    if (pending || current === undefined) return Promise.resolve(false);
    if (normalizeReplayIntent(intent) !== current.normalizedIntent) {
      setError(
        'The fields now describe a different replay. Restore the original values or dismiss this attempt before starting another replay.',
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

function normalizeReplayIntent(intent: RunReplayIntent): string {
  return canonicalizeJson({
    deadlineAt: intent.deadlineAt ?? null,
    value: intent.value,
  });
}

function isUncertain(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

function runReplayError(error: unknown): string {
  if (isUncertain(error))
    return 'The replay result is uncertain. Retry the same values to reuse this command safely.';
  if (isApiError(error) && error.status === 403)
    return 'You no longer have permission to replay this run.';
  if (isApiError(error) && error.status === 409)
    return 'This replay conflicts with an earlier command. Dismiss it before starting a new replay.';
  return 'The run could not be replayed.';
}
