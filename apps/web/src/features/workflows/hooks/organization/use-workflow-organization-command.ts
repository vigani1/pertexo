import {
  isRevisionConflict,
  querySnapshot,
  refreshQuerySnapshot,
  type SnapshotRead,
} from '@/lib/api/query-snapshot';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import type { WorkflowOrganizationInput } from '../../model/organization/requests';
import { sendWorkflowOrganizationCommand } from '../../data/organization/workflow-organization.api';
import { workflowOrganizationKeys } from '../../data/organization/workflow-organization.queries';
import { workflowKeys } from '../../data/workflows.queries';
import { allowed, type RequiredRole } from '../../data/organization/authority';

export type WorkflowOrganizationCommandResult = Awaited<
  ReturnType<typeof sendWorkflowOrganizationCommand>
>;
export type WorkflowOrganizationCommandOptions = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  requiredRole: RequiredRole;
}>;
export type WorkflowOrganizationCommand = ReturnType<
  typeof useWorkflowOrganizationCommand
>;

export function useWorkflowOrganizationCommand({
  apiClient,
  userId,
  workspace,
  requiredRole,
}: WorkflowOrganizationCommandOptions) {
  const cache = useQueryClient();
  const [revisionRead, setRevisionRead] = useState<SnapshotRead<unknown>>();
  const [foreignScope, setForeignScope] = useState(false);
  const workspaceId = workspace.id;
  const mutation = useLowEffectMutation({
    send: async (
      input: WorkflowOrganizationInput,
      key,
    ): Promise<WorkflowOrganizationCommandResult> =>
      sendWorkflowOrganizationCommand(apiClient, {
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
  const revisionRefresh = useMutation({
    mutationFn: () =>
      refreshQuerySnapshot(
        cache,
        workflowOrganizationKeys.folders(userId, workspaceId),
      ),
    onSuccess: setRevisionRead,
  });
  const pending = mutation.isPending || revisionRefresh.isPending;
  const partialDenied =
    mutation.data !== undefined &&
    'items' in mutation.data &&
    mutation.data.items.some((item) => item.status === 'forbidden');
  const denied = !allowed(workspace, requiredRole) || partialDenied;
  async function start(input: WorkflowOrganizationInput) {
    if (pending || denied || !allowed(workspace, requiredRole)) return;
    setForeignScope(input.workspaceId !== workspaceId);
    if (input.workspaceId !== workspaceId) return;
    setRevisionRead(undefined);
    try {
      await mutation.mutateAsync(input);
    } catch (error) {
      if (isRevisionConflict(error))
        setRevisionRead(
          querySnapshot(
            cache,
            workflowOrganizationKeys.folders(userId, workspaceId),
          ),
        );
    }
  }
  let error: string | undefined;
  if (foreignScope) error = 'The command belongs to a different workspace.';
  else if (mutation.isError) error = definitiveMessage(mutation.error);
  return {
    pending,
    result: mutation.data,
    denied,
    error,
    revisionConflict: revisionRead !== undefined,
    revisionRead,
    start,
    retryRevisionRead: async () => {
      await revisionRefresh.mutateAsync();
    },
    reset: () => {
      if (!pending) {
        mutation.reset();
        setRevisionRead(undefined);
        setForeignScope(false);
      }
    },
  };
}

function definitiveMessage(error: unknown) {
  // Every transport, decode and server failure is an ApiError; anything else
  // is the request's own validation refusing the command before it was sent.
  if (!isApiError(error)) return 'The organization command is invalid.';
  const messages: Readonly<Record<string, string>> = {
    'workflow.folder_name_conflict':
      'Another folder in this parent already has that name.',
    'workflow.folder_limit_exceeded':
      'The workspace folder limit has been reached.',
    'workflow.folder_revision_conflict':
      'This folder changed. Refresh it before trying again.',
    'workflow.folder_hierarchy_conflict':
      'This move would create a cycle or exceed the folder depth limit.',
    'workflow.folder_not_empty':
      'Move the workflows and child folders out before deleting this folder.',
    'workflow.folder_not_visible':
      'This folder is no longer visible. Refresh the workspace.',
    'workflow.tag_delete_overflow':
      'This tag has too many assignments to delete at once. Use bounded cleanup first.',
    'workflow.tag_key_conflict': 'Another workspace tag already has that key.',
    'workflow.tag_limit_exceeded': 'The workspace tag limit has been reached.',
    'workflow.tag_revision_conflict':
      'This tag changed. Refresh it before trying again.',
    'workflow.organization_revision_conflict':
      'Workflow organization changed. Refresh it before trying again.',
    'request.idempotency_conflict':
      'This retry doesn’t match the change it started from. Discard it and refresh before making a new change.',
  };
  const code = isApiError(error) ? error.problem?.code : undefined;
  return code !== undefined && Object.hasOwn(messages, code)
    ? (messages[code] ?? 'That change wasn’t saved.')
    : lowEffectError(error, 'changing workflow organization');
}
