import { isAccessLost } from '@/lib/api/error-copy';
import { useEffect, useRef, useState } from 'react';
import {
  normalizeRunIntent,
  startWorkflowRun,
  type RunIntent,
} from '@/features/workflow-runs/commands.public';
import type { ApiClient } from '@/lib/api/client';
import { getAllAccessibleWorkspaces } from '@/features/workspaces/queries.public';
import { ApiError, isApiError } from '@/lib/api/error';
import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { commandErrorMessage } from './command-utils';

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

type RunSubmissionOptions = Readonly<{
  apiClient: ApiClient;
  userId?: string;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  isSessionPaused: () => boolean;
  ensureSaved: () => Promise<unknown>;
  onRunAccepted: (runId: string) => void;
  onRunCommandAccepted?: () => void;
}>;

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
}: RunSubmissionOptions) {
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
  const runScope = { apiClient, userId, workspaceId, workflowId };
  const owner = useRunAttemptOwner(runScope, attempt);
  const sending = useRef<symbol | undefined>(undefined);

  async function startNew(intent: RunIntent) {
    const runSubmissionBlocked =
      pending ||
      publicationConflict ||
      attempt.current !== undefined ||
      acceptedRunId !== undefined ||
      isSessionPaused();
    if (runSubmissionBlocked) return false;
    const command = createRunAttempt(intent);
    return submitAttempt({ command, needsSaveBarrier: true });
  }

  async function retry() {
    const retryBlockedByCommand = pending || acceptedRunId !== undefined;
    if (retryBlockedByCommand) return false;
    if (attempt.current === undefined) return false;
    if (isSessionPaused()) return false;
    if (runRecoveryClock() >= attempt.current.recoveryUntil) {
      setError(
        'The 24-hour recovery window has ended. Check run history before deciding whether to start another run; retrying can no longer guarantee the original result.',
      );
      return false;
    }
    return submitAttempt({ command: attempt.current, needsSaveBarrier: false });
  }

  async function submitAttempt({
    command,
    needsSaveBarrier,
  }: Readonly<{ command: RunAttempt; needsSaveBarrier: boolean }>) {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined) return false;
    if (sending.current === submissionOwner) return false;
    sending.current = submissionOwner;
    let submitted = false;
    setInFlight(submissionOwner);
    setError(undefined);
    try {
      const authorized = await authorizeRunSubmission(
        { apiClient, userId, workspaceId, verifyIdentity, ensureSaved },
        {
          needsSaveBarrier,
          isCurrent: () => owner.current === submissionOwner,
        },
      );
      if (!authorized) return false;
      attempt.current = command;
      setRetryAvailable(false);
      submitted = true;
      const response = await startWorkflowRun(
        apiClient,
        workspaceId,
        workflowId,
        runAttemptPayload(command),
      );
      if (owner.current !== submissionOwner) return false;
      attempt.current = undefined;
      setRetryAvailable(false);
      setAcceptedRunId(response.run.id);
      setRecoveryIntent(undefined);
      onRunCommandAccepted?.();
      if (!isSessionPaused()) {
        try {
          await verifyIdentity();
        } catch (cause) {
          // The run is accepted; a failed check only keeps it from opening
          // by itself, and Open accepted run checks again.
          if (owner.current === submissionOwner)
            setError(commandErrorMessage(cause, 'opening the run'));
          return true;
        }
        if (owner.current === submissionOwner && !isSessionPaused())
          onRunAccepted(response.run.id);
      }
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      if (isAccessLost(cause)) {
        attempt.current = undefined;
        setRetryAvailable(false);
      }
      if (submitted) {
        setPublicationConflict(publicationVersionChanged(cause));
        const uncertain = isUnconfirmedCommand(cause);
        setRecoveryIntent(uncertain ? command.intent : undefined);
        if (!uncertain) attempt.current = undefined;
        setRetryAvailable(uncertain && attempt.current !== undefined);
      }
      setError(runSubmissionFailureMessage(cause, { submitted }));
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
    openAcceptedRun: () =>
      openAcceptedRun({
        pending,
        acceptedRunId,
        owner,
        setInFlight,
        setError,
        verifyIdentity,
        isSessionPaused,
        onRunAccepted,
      }),
    retry,
    startNew,
  };
}

async function authorizeRunSubmission(
  {
    apiClient,
    userId,
    workspaceId,
    verifyIdentity,
    ensureSaved,
  }: Pick<
    RunSubmissionOptions,
    'apiClient' | 'workspaceId' | 'verifyIdentity' | 'ensureSaved'
  > &
    Readonly<{ userId: RunSubmissionOptions['userId'] }>,
  {
    needsSaveBarrier,
    isCurrent,
  }: Readonly<{ needsSaveBarrier: boolean; isCurrent: () => boolean }>,
) {
  await verifyIdentity();
  if (!isCurrent()) return false;
  if (needsSaveBarrier) await ensureSaved();
  if (!isCurrent()) return false;
  if (userId !== undefined) {
    await requireRunAuthority(apiClient, workspaceId);
    if (!isCurrent()) return false;
  }
  return true;
}

function runAttemptPayload(
  command: RunAttempt,
): Parameters<typeof startWorkflowRun>[3] {
  return {
    value: command.intent.value,
    ...(command.intent.deadlineAt === undefined
      ? {}
      : { deadlineAt: command.intent.deadlineAt }),
    idempotencyKey: command.idempotencyKey,
    ...(command.intent.expectedPublishedVersionId === undefined
      ? {}
      : {
          expectedPublishedVersionId: command.intent.expectedPublishedVersionId,
        }),
  };
}
function publicationVersionChanged(error: unknown) {
  return (
    isApiError(error) &&
    error.problem?.code === 'workflow.published_version_conflict'
  );
}
function runSubmissionFailureMessage(
  error: unknown,
  { submitted }: Readonly<{ submitted: boolean }>,
) {
  if (submitted && isUnconfirmedCommand(error))
    return 'We couldn’t confirm whether this run started. Retry the same input, deadline and version within 24 hours of the first attempt. Don’t start a replacement run before resolving it.';
  return commandErrorMessage(error, 'starting this run');
}

async function openAcceptedRun({
  pending,
  acceptedRunId,
  owner,
  setInFlight,
  setError,
  verifyIdentity,
  isSessionPaused,
  onRunAccepted,
}: Pick<
  RunSubmissionOptions,
  'verifyIdentity' | 'isSessionPaused' | 'onRunAccepted'
> &
  Readonly<{
    pending: boolean;
    acceptedRunId: string | undefined;
    owner: Readonly<{ current: symbol | undefined }>;
    setInFlight: (
      value:
        | symbol
        | undefined
        | ((current: symbol | undefined) => symbol | undefined),
    ) => void;
    setError: (message: string | undefined) => void;
  }>) {
  if (pending || acceptedRunId === undefined || isSessionPaused()) return false;
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

function useRunAttemptOwner(
  {
    apiClient,
    userId,
    workspaceId,
    workflowId,
  }: Readonly<{
    apiClient: ApiClient;
    userId: string | undefined;
    workspaceId: string;
    workflowId: string;
  }>,
  attemptRef: { current: RunAttempt | undefined },
) {
  const owner = useRef<symbol | undefined>(undefined);
  useEffect(() => {
    const currentOwner = Symbol('workflow-run-submission');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        attemptRef.current = undefined;
      }
    };
  }, [apiClient, userId, workspaceId, workflowId, attemptRef]);
  return owner;
}
