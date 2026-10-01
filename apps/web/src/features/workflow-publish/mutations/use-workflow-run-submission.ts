import { useEffect, useRef, useState } from 'react';
import {
  normalizeRunIntent,
  startWorkflowRun,
  type RunIntent,
} from '@/features/workflow-runs/commands.public';
import type { ApiClient } from '@/lib/api/client';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { ApiError, isApiError } from '@/lib/api/api-error';
import { commandErrorMessage, isUncertainCommandError } from './command-utils';

type RunAttempt = Readonly<{
  intent: RunIntent;
  normalizedIntent: string;
  idempotencyKey: string;
  recoveryUntil: number;
}>;

// Read only during an explicit command, never during render.
function runRecoveryClock() {
  return Date.now();
}

function createRunAttempt(intent: RunIntent): RunAttempt {
  return {
    intent: { ...intent, value: structuredClone(intent.value) },
    normalizedIntent: normalizeRunIntent(intent),
    idempotencyKey: crypto.randomUUID(),
    recoveryUntil: runRecoveryClock() + 24 * 60 * 60 * 1000,
  };
}

async function requireRunAuthority(api: ApiClient, workspaceId: string) {
  const workspace = (await getAllAccessibleWorkspaces(api)).find(
    (item) => item.id === workspaceId,
  );
  if (
    workspace?.status !== 'active' ||
    !workspace.capabilities.includes('run:start')
  )
    throw new ApiError({
      kind: 'problem',
      status: 403,
      message: 'Run-start authority is no longer available.',
    });
}

export function useWorkflowRunSubmission({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  verifyIdentity,
  isSessionPaused,
  ensureSaved,
  onRunAccepted,
  onRunCommandAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId?: string;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  isSessionPaused: () => boolean;
  ensureSaved: () => Promise<unknown>;
  onRunAccepted: (runId: string) => void;
  onRunCommandAccepted?: () => void;
}>) {
  // The submission in flight, if any: each one clears only its own marker,
  // so an answer from an earlier scope can't end a newer submission's wait.
  const [inFlight, setInFlight] = useState<symbol>();
  const pending = inFlight !== undefined;
  const [error, setError] = useState<string>();
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [acceptedRunId, setAcceptedRunId] = useState<string>();
  const [publicationConflict, setPublicationConflict] = useState(false);
  const [recoveryIntent, setRecoveryIntent] = useState<RunIntent>();
  const attempt = useRef<RunAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);
  const sending = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('workflow-run-submission');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        attempt.current = undefined;
      }
    };
  }, [apiClient, userId, workspaceId, workflowId]);

  async function startNew(intent: RunIntent) {
    if (
      pending ||
      publicationConflict ||
      attempt.current !== undefined ||
      acceptedRunId !== undefined ||
      isSessionPaused()
    )
      return false;
    const command = createRunAttempt(intent);
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
    if (runRecoveryClock() >= attempt.current.recoveryUntil) {
      setError(
        'The 24-hour recovery window has ended. Check run history before deciding whether to start another run; retrying can no longer guarantee the original result.',
      );
      return false;
    }
    return submitAttempt(attempt.current, false);
  }

  async function openAcceptedRun() {
    if (pending || acceptedRunId === undefined || isSessionPaused())
      return false;
    const submissionOwner = owner.current;
    if (submissionOwner === undefined) return false;
    setInFlight(submissionOwner);
    setError(undefined);
    try {
      await verifyIdentity();
      if (owner.current !== submissionOwner || isSessionPaused()) return false;
      const runId = acceptedRunId;
      onRunAccepted(runId);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      setError(commandErrorMessage(cause, 'opening the run'));
      return false;
    } finally {
      setInFlight((current) =>
        current === submissionOwner ? undefined : current,
      );
    }
  }

  async function submitAttempt(command: RunAttempt, needsSaveBarrier: boolean) {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined) return false;
    if (sending.current === submissionOwner) return false;
    sending.current = submissionOwner;
    let submitted = false;
    setInFlight(submissionOwner);
    setError(undefined);
    try {
      await verifyIdentity();
      if (owner.current !== submissionOwner) return false;
      if (needsSaveBarrier) await ensureSaved();
      if (owner.current !== submissionOwner) return false;
      if (userId !== undefined) {
        await requireRunAuthority(apiClient, workspaceId);
        if (owner.current !== submissionOwner) return false;
      }
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
          ...(command.intent.expectedPublishedVersionId === undefined
            ? {}
            : {
                expectedPublishedVersionId:
                  command.intent.expectedPublishedVersionId,
              }),
        },
      );
      if (owner.current !== submissionOwner) return false;
      attempt.current = undefined;
      setRetryAvailable(false);
      setAcceptedRunId(response.run.id);
      setRecoveryIntent(undefined);
      onRunCommandAccepted?.();
      if (!isSessionPaused()) {
        await verifyIdentity();
        if (owner.current === submissionOwner && !isSessionPaused())
          onRunAccepted(response.run.id);
      }
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      if (isApiError(cause) && [401, 403, 404].includes(cause.status ?? 0)) {
        attempt.current = undefined;
        setRetryAvailable(false);
      }
      if (submitted) {
        setPublicationConflict(
          isApiError(cause) &&
            cause.problem?.code === 'workflow.published_version_conflict',
        );
        const uncertain = isUncertainCommandError(cause);
        setRecoveryIntent(uncertain ? command.intent : undefined);
        if (!uncertain) attempt.current = undefined;
        setRetryAvailable(uncertain && attempt.current !== undefined);
      }
      setError(
        submitted && isUncertainCommandError(cause)
          ? 'We couldn’t confirm whether this run started. Retry the same input, deadline and version within 24 hours of the first attempt. Don’t start a replacement run before resolving it.'
          : commandErrorMessage(cause, 'starting this run'),
      );
      return false;
    } finally {
      if (sending.current === submissionOwner) sending.current = undefined;
      setInFlight((current) =>
        current === submissionOwner ? undefined : current,
      );
    }
  }

  return {
    acceptedRunId,
    pending,
    error,
    retryAvailable,
    publicationConflict,
    recoveryIntent,
    clearPublicationConflict: () => {
      setPublicationConflict(false);
      setError(undefined);
    },
    openAcceptedRun,
    retry,
    startNew,
  };
}
