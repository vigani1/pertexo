import { observeSessionChanges } from '@/features/auth/session/sync.public';
import { useEffect, useRef, useState } from 'react';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDuplicateRequest } from '@pertexo/contracts';
import { useCreateCommand } from '@/lib/api/commands/use-create-command';
import {
  readAccessLost,
  shownData,
  isAccessLost,
  describeCommandError,
} from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import {
  duplicateWorkflow,
  getWorkflowDuplicateDraft,
  type WorkflowDuplicateAttempt,
} from '../../data/workflows.api';
import { workflowKeys } from '../../data/workflows.queries';
import { workflowOrganizationKeys } from '../../data/organization/workflow-organization.queries';
import type { DuplicateState } from '../../model/duplicate/duplicate-command-state';

export function useWorkflowDuplicate({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  source,
  allowed,
  onCreated,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  source: WorkflowDuplicateRequest['source'];
  allowed: boolean;
  onCreated: (workflowId: string) => void;
  onAccessLost: () => void;
}>) {
  const cache = useQueryClient();
  const [sourceDenied, setSourceDenied] = useState(false);
  const deniedRead = useRef(false);
  useEffect(() => {
    const retire = () => {
      deniedRead.current = true;
      setSourceDenied(true);
      onAccessLost();
      const queryKey = workflowKeys.detail(userId, workspaceId, workflowId);
      void cache.cancelQueries({ queryKey });
      cache.removeQueries({ queryKey });
    };
    const stopSession = observeSessionChanges(retire);
    const stopReads = watchWorkspaceReadDenial({
      queryClient: cache,
      userId,
      workspaceId,
      counts: ({ key }) =>
        key[0] === 'workflows' ||
        (key[0] === 'workflow' && key[1] === workflowId),
      denied: retire,
    });
    return () => {
      stopSession();
      stopReads();
    };
  }, [cache, userId, workspaceId, workflowId, onAccessLost]);

  const draft = useQuery({
    queryKey: [
      ...workflowKeys.detail(userId, workspaceId, workflowId),
      'duplicate-draft',
    ],
    queryFn: ({ signal }) =>
      getWorkflowDuplicateDraft(apiClient, workspaceId, workflowId, signal),
    enabled: allowed && source.kind === 'draft',
  });
  const command = useCreateCommand({
    send: (attempt: Omit<WorkflowDuplicateAttempt, 'idempotencyKey'>, key) =>
      duplicateWorkflow({
        apiClient,
        workspaceId,
        workflowId,
        attempt: { ...attempt, idempotencyKey: key },
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
  const readDenied = sourceDenied || readAccessLost(draft);
  const stale =
    command.failed &&
    isApiError(command.error) &&
    command.error.kind === 'problem' &&
    command.error.status === 412;
  let kind: DuplicateState['kind'] = 'ready';
  if (!allowed || readDenied) kind = 'denied';
  else if (command.pending) kind = 'sending';
  else if (source.kind === 'draft') {
    if (draft.isPending || draft.isFetching) kind = 'loading';
    else if (draft.isError) kind = 'failed';
    else if (stale) kind = 'stale';
  }
  const error = readDenied
    ? 'Access changed. Close this dialog and check your access to the source.'
    : duplicateError(command, stale, draft.isError ? draft.error : undefined);
  const current = shownData(draft);
  const state: DuplicateState = {
    kind,
    ...(current === undefined ? {} : { draft: current }),
    error,
  };
  async function start(name: string) {
    if (state.kind !== 'ready') return;
    let result: Awaited<ReturnType<typeof command.create>>;
    try {
      result = await command.create({
        body: { name, source },
        ...(draft.data === undefined ? {} : { etag: draft.data.etag }),
      });
    } catch {
      return; // The command owns the displayed failure.
    }
    if (result === undefined) return;
    const read = cache.getQueryState([
      ...workflowKeys.detail(userId, workspaceId, workflowId),
      'duplicate-draft',
    ]);
    if (!deniedRead.current && !isAccessLost(read?.error))
      onCreated(result.workflowId);
  }
  return {
    state,
    start,
    /** An unconfirmed copy holds its key; closing would drop the safe retry. */
    uncertain: command.uncertain && !command.expired,
    expired: command.expired,
    startNewAttempt: command.startNewAttempt,
    editName: command.reset,
    refresh: () => {
      command.reset();
      void draft.refetch();
    },
  };
}

/** One visible message: the copy's outcome first, then the source read. */
function duplicateError(
  command: Readonly<{
    expired: boolean;
    uncertain: boolean;
    failed: boolean;
    error: unknown;
  }>,
  stale: boolean,
  readError: unknown,
): string | undefined {
  if (command.expired) return undefined;
  if (command.uncertain)
    return 'We couldn’t confirm whether the copy was made. Retrying is safe — it won’t make a second copy.';
  if (command.failed)
    return stale
      ? 'The saved source changed. Read the current draft, then confirm a new copy.'
      : describeCommandError(command.error, 'duplicating this workflow');
  return readError === undefined
    ? undefined
    : describeCommandError(readError, 'reading the saved source');
}
