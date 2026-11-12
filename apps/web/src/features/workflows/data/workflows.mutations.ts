import { useQueryClient } from '@tanstack/react-query';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import { useCreateCommand } from '@/lib/api/commands/use-create-command';
import type {
  InlineRenameCommand,
  InlineRenameError,
} from '@/components/patterns/actions/rename/inline-rename.types';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import {
  createWorkflow,
  renameWorkflow,
  transitionWorkflowLifecycle,
  type WorkflowLifecycleCommand,
  type WorkflowRenameAttempt,
} from './workflows.api';
import type { LifecycleAction } from '../model/lifecycle';
import { workflowKeys } from './workflows.queries';
import { workflowOrganizationKeys } from './organization/workflow-organization.queries';

export function useCreateWorkflow(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const cache = useQueryClient();
  return useCreateCommand({
    send: (input: Readonly<{ name: string }>, key) =>
      createWorkflow(apiClient, workspaceId, { ...input, idempotencyKey: key }),
    refresh: () =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]),
  });
}

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
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (input: Omit<WorkflowLifecycleCommand, 'idempotencyKey'>, key) =>
      transitionWorkflowLifecycle(apiClient, workspaceId, workflowId, {
        ...input,
        idempotencyKey: key,
      }),
    refresh: () =>
      Promise.all([
        cache.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.scope(userId, workspaceId),
        }),
      ]),
  });
  async function submit(
    command: LifecycleAction,
    expectedLifecycleRevision: number,
  ) {
    if (mutation.isPending) return false;
    try {
      await mutation.mutateAsync({ command, expectedLifecycleRevision });
      return true;
    } catch {
      return false;
    }
  }
  let error: string | undefined;
  if (mutation.isError)
    error =
      isApiError(mutation.error) &&
      mutation.error.problem?.code === 'workflow.lifecycle_conflict'
        ? 'This workflow changed since you opened this. Close it and check the workflow’s current state.'
        : lowEffectError(mutation.error, 'changing this workflow');
  return { submit, pending: mutation.isPending, reset: mutation.reset, error };
}

const RENAME_CONFLICT: InlineRenameError = {
  kind: 'conflict',
  message: 'This workflow changed while you were editing.',
};
function renameError(error: unknown): InlineRenameError {
  const code = isApiError(error) ? error.problem?.code : undefined;
  if (code === 'workflow.name_conflict') return RENAME_CONFLICT;
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
  const cache = useQueryClient();
  const detailKey = workflowKeys.detail(userId, workspaceId, workflowId);
  const mutation = useLowEffectMutation({
    send: (input: Omit<WorkflowRenameAttempt, 'idempotencyKey'>, key) =>
      renameWorkflow(apiClient, workspaceId, workflowId, {
        ...input,
        idempotencyKey: key,
      }),
    refresh: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: detailKey, exact: true }),
        cache.invalidateQueries({
          queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.lists(userId, workspaceId),
        }),
        cache.invalidateQueries({
          queryKey: workflowKeys.recent(userId, workspaceId),
        }),
      ]),
  });
  async function reloadLatest() {
    try {
      await cache.refetchQueries(
        { queryKey: detailKey, exact: true },
        { throwOnError: true },
      );
      return true;
    } catch {
      return false;
    }
  }
  async function start(name: string, expectedNameRevision: number) {
    if (mutation.isPending) return false;
    try {
      const { workflow } = await mutation.mutateAsync({
        name,
        expectedNameRevision,
      });
      onRenamed(workflow.name);
      return true;
    } catch (cause) {
      if (renameError(cause) === RENAME_CONFLICT) void reloadLatest();
      return false;
    }
  }
  let error: InlineRenameError | undefined;
  if (mutation.isError)
    error =
      renameError(mutation.error).kind === 'conflict'
        ? RENAME_CONFLICT
        : {
            kind: 'other',
            message: lowEffectError(mutation.error, 'renaming the workflow'),
          };
  return {
    start,
    pending: mutation.isPending,
    error,
    reloadLatest,
    clearError: mutation.reset,
  };
}
