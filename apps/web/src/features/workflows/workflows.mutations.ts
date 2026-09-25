import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type {
  InlineRenameCommand,
  InlineRenameError,
} from '@/components/patterns/inline-rename';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import {
  createWorkflow,
  renameWorkflow,
  transitionWorkflowLifecycle,
  type CreatedWorkflow,
  type WorkflowLifecycleCommand,
  type WorkflowRenameAttempt,
} from './workflows.api';
import type { LifecycleAction } from './model/workflow-lifecycle';
import { workflowKeys } from './workflows.queries';

/**
 * Saves a starter graph into a new workflow's draft with the ETag returned by
 * creation. The editor owns draft saving; routes pass its transport in.
 */
export type StarterDraftWriter = (
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{ graph: WorkflowGraphContract; etag: string }>,
) => Promise<unknown>;

export type StarterSeed = Readonly<{
  graph: WorkflowGraphContract;
  write: StarterDraftWriter;
}>;

export type CreateWorkflowResult = Readonly<{
  created: CreatedWorkflow;
  /** Whether the starter steps reached the draft; `none` for Blank. */
  seeded: 'none' | 'saved' | 'failed' | 'uncertain';
}>;

export function useCreateWorkflow(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Readonly<{
        name: string;
        idempotencyKey: string;
        seed?: StarterSeed;
      }>,
    ): Promise<CreateWorkflowResult> => {
      const created = await createWorkflow(apiClient, workspaceId, input);
      if (input.seed === undefined) return { created, seeded: 'none' };
      try {
        await input.seed.write(
          apiClient,
          workspaceId,
          created.body.workflow.id,
          { graph: input.seed.graph, etag: created.draftEtag },
        );
        return { created, seeded: 'saved' };
      } catch (error) {
        // The workflow exists either way; only its starter steps are unsure.
        return {
          created,
          seeded: isUncertainOutcome(error) ? 'uncertain' : 'failed',
        };
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      }),
  });
}

function lifecycleErrorMessage(error: unknown, action: LifecycleAction) {
  const verb = action === 'archive' ? 'archiving' : 'restoring';
  if (isUncertainOutcome(error))
    return `We couldn’t confirm whether ${verb} went through. Retrying is safe — it won’t be applied twice.`;
  if (isApiError(error) && error.status === 409)
    return 'This workflow changed since you opened this. Close it and check the workflow’s current state.';
  return describeCommandError(error, `${verb} this workflow`);
}

/**
 * Archive or restore with one exact command per confirmation: an uncertain
 * failure keeps the same idempotency key and expected revision for a retry.
 */
export function useWorkflowLifecycleCommand({
  apiClient,
  userId,
  workspaceId,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>) {
  const queryClient = useQueryClient();
  const commandRef = useRef<WorkflowLifecycleCommand | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<
    Readonly<{ message: string; exactRetry: boolean }> | undefined
  >();

  async function submit(
    command: LifecycleAction,
    expectedLifecycleRevision: number,
  ): Promise<boolean> {
    if (pending) return false;
    const exactCommand =
      commandRef.current ??
      (commandRef.current = {
        command,
        expectedLifecycleRevision,
        idempotencyKey: crypto.randomUUID(),
      });
    setPending(true);
    setError(undefined);
    try {
      await transitionWorkflowLifecycle(
        apiClient,
        workspaceId,
        workflowId,
        exactCommand,
      );
      commandRef.current = undefined;
      await queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
      return true;
    } catch (cause) {
      const exactRetry = isUncertainOutcome(cause);
      if (!exactRetry) commandRef.current = undefined;
      setError({
        message: lifecycleErrorMessage(cause, exactCommand.command),
        exactRetry,
      });
      return false;
    } finally {
      setPending(false);
    }
  }

  return {
    pending,
    error: error?.message,
    exactRetry: error?.exactRetry === true,
    reset: () => {
      commandRef.current = undefined;
      setError(undefined);
    },
    submit,
  };
}

const RENAME_CONFLICT: InlineRenameError = {
  kind: 'conflict',
  message: 'This workflow changed while you were editing.',
};
const RENAME_UNCERTAIN: InlineRenameError = {
  kind: 'other',
  message:
    'We couldn’t confirm whether the rename went through. Try again — it can’t apply twice.',
};

function renameError(error: unknown): InlineRenameError {
  const code = isApiError(error) ? error.problem?.code : undefined;
  if (code === 'workflow.name_conflict') return RENAME_CONFLICT;
  if (code === 'request.idempotency_conflict')
    return {
      kind: 'other',
      message:
        'This request was already used with different details. Try again.',
    };
  if (isApiError(error) && error.status === 404)
    return {
      kind: 'other',
      message:
        'This workflow can’t be renamed now. It may have been archived or removed.',
    };
  return {
    kind: 'other',
    message: describeCommandError(error, 'renaming the workflow'),
  };
}

type RenameState =
  | Readonly<{ kind: 'idle'; error?: InlineRenameError }>
  | Readonly<{ kind: 'sending' }>
  | Readonly<{
      kind: 'uncertain';
      attempt: WorkflowRenameAttempt;
      error: InlineRenameError;
    }>;

/**
 * Renames at the name revision the edit started from (ADR 041). An
 * unconfirmed attempt keeps its exact key for a retry; a conflict reloads
 * the workflow so people choose between their name and the newer one.
 */
export function useWorkflowRename({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  onRenamed,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  onRenamed: (name: string) => void;
}>): InlineRenameCommand &
  Readonly<{
    start: (name: string, expectedNameRevision: number) => Promise<boolean>;
  }> {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RenameState>({ kind: 'idle' });
  const inFlight = useRef(false);
  const detailKey = workflowKeys.detail(userId, workspaceId, workflowId);

  async function reloadLatest(): Promise<boolean> {
    try {
      await queryClient.refetchQueries({ queryKey: detailKey, exact: true });
      return true;
    } catch {
      return false;
    }
  }

  async function send(attempt: WorkflowRenameAttempt): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setState({ kind: 'sending' });
    try {
      const { workflow } = await renameWorkflow(
        apiClient,
        workspaceId,
        workflowId,
        attempt,
      );
      queryClient.setQueryData(detailKey, workflow);
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.lists(userId, workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.recent(userId, workspaceId),
      });
      setState({ kind: 'idle' });
      onRenamed(workflow.name);
      return true;
    } catch (cause) {
      if (isUncertainOutcome(cause)) {
        setState({ kind: 'uncertain', attempt, error: RENAME_UNCERTAIN });
        return false;
      }
      const error = renameError(cause);
      setState({ kind: 'idle', error });
      if (error === RENAME_CONFLICT) void reloadLatest();
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  return {
    pending: state.kind === 'sending',
    error: state.kind === 'sending' ? undefined : state.error,
    retryAvailable: state.kind === 'uncertain',
    start: (name, expectedNameRevision) =>
      state.kind === 'idle'
        ? send({
            name,
            expectedNameRevision,
            idempotencyKey: crypto.randomUUID(),
          })
        : Promise.resolve(false),
    retry: () =>
      state.kind === 'uncertain' ? send(state.attempt) : Promise.resolve(false),
    reloadLatest,
    dismiss: () => {
      if (state.kind === 'uncertain') setState({ kind: 'idle' });
    },
    clearError: () => {
      if (state.kind === 'idle' && state.error !== undefined)
        setState({ kind: 'idle' });
    },
  };
}
