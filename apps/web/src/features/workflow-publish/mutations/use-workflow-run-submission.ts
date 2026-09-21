import { useEffect, useRef, useState } from 'react';
import { startWorkflowRun } from '@/features/workflow-runs/commands.public';
import type { ApiClient } from '@/lib/api/client';
import { canonicalizeJson } from '@/lib/canonical-json';
import { commandErrorMessage, isUncertainCommandError } from './command-utils';

export type WorkflowRunIntent = Readonly<{
  value: unknown;
  deadlineAt?: string;
}>;

type RunAttempt = Readonly<{
  intent: WorkflowRunIntent;
  normalizedIntent: string;
  idempotencyKey: string;
}>;

export function useWorkflowRunSubmission({
  apiClient,
  workspaceId,
  workflowId,
  verifyIdentity,
  isSessionPaused,
  ensureSaved,
  onRunAccepted,
  onRunCommandAccepted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  isSessionPaused: () => boolean;
  ensureSaved: () => Promise<unknown>;
  onRunAccepted: (runId: string) => void;
  onRunCommandAccepted?: () => void;
}>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [acceptedRunId, setAcceptedRunId] = useState<string>();
  const attempt = useRef<RunAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('workflow-run-submission');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        attempt.current = undefined;
      }
    };
  }, [apiClient, workspaceId, workflowId]);

  async function startNew(intent: WorkflowRunIntent) {
    if (pending || acceptedRunId !== undefined || isSessionPaused())
      return false;
    const command = {
      intent,
      normalizedIntent: normalizeRunIntent(intent),
      idempotencyKey: crypto.randomUUID(),
    };
    return submitAttempt(command, true);
  }

  async function retry() {
    if (
      pending ||
      acceptedRunId !== undefined ||
      attempt.current === undefined ||
      isSessionPaused()
    )
      return false;
    return submitAttempt(attempt.current, false);
  }

  async function openAcceptedRun() {
    if (pending || acceptedRunId === undefined || isSessionPaused())
      return false;
    const submissionOwner = owner.current;
    if (submissionOwner === undefined) return false;
    setPending(true);
    setError(undefined);
    try {
      await verifyIdentity();
      if (owner.current !== submissionOwner || isSessionPaused()) return false;
      const runId = acceptedRunId;
      onRunAccepted(runId);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      setError(commandErrorMessage(cause, 'open the accepted run'));
      return false;
    } finally {
      if (owner.current === submissionOwner) setPending(false);
    }
  }

  async function submitAttempt(command: RunAttempt, needsSaveBarrier: boolean) {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined) return false;
    let submitted = false;
    setPending(true);
    setError(undefined);
    try {
      await verifyIdentity();
      if (owner.current !== submissionOwner) return false;
      if (needsSaveBarrier) await ensureSaved();
      if (owner.current !== submissionOwner) return false;
      attempt.current = command;
      setRetryAvailable(false);
      submitted = true;
      const response = await startWorkflowRun(
        apiClient,
        workspaceId,
        workflowId,
        {
          value: command.intent.value,
          ...(command.intent.deadlineAt === undefined
            ? {}
            : { deadlineAt: command.intent.deadlineAt }),
          idempotencyKey: command.idempotencyKey,
        },
      );
      if (owner.current !== submissionOwner) return false;
      attempt.current = undefined;
      setRetryAvailable(false);
      onRunCommandAccepted?.();
      if (isSessionPaused()) setAcceptedRunId(response.run.id);
      else onRunAccepted(response.run.id);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      if (submitted) {
        const uncertain = isUncertainCommandError(cause);
        if (!uncertain) attempt.current = undefined;
        setRetryAvailable(uncertain && attempt.current !== undefined);
      }
      setError(commandErrorMessage(cause, 'start the published workflow'));
      return false;
    } finally {
      if (owner.current === submissionOwner) setPending(false);
    }
  }

  return {
    acceptedRunId,
    pending,
    error,
    retryAvailable,
    openAcceptedRun,
    retry,
    startNew,
  };
}

export function normalizeRunIntent(intent: WorkflowRunIntent): string {
  return canonicalizeJson({
    deadlineAt: intent.deadlineAt ?? null,
    value: intent.value,
  });
}
