import { useEffect, useRef, useState } from 'react';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDuplicateRequest } from '@pertexo/contracts';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
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
  useEffect(
    () =>
      watchWorkspaceReadDenial({
        queryClient: cache,
        userId,
        workspaceId,
        counts: ({ key }) =>
          key[0] === 'workflows' ||
          (key[0] === 'workflow' && key[1] === workflowId),
        denied: () => {
          deniedRead.current = true;
          setSourceDenied(true);
          onAccessLost();
          const queryKey = workflowKeys.detail(userId, workspaceId, workflowId);
          void cache.cancelQueries({ queryKey });
          cache.removeQueries({ queryKey });
        },
      }),
    [cache, userId, workspaceId, workflowId, onAccessLost],
  );
  const draft = useQuery({
    queryKey: [
      ...workflowKeys.detail(userId, workspaceId, workflowId),
      'duplicate-draft',
    ],
    queryFn: ({ signal }) =>
      getWorkflowDuplicateDraft(apiClient, workspaceId, workflowId, signal),
    enabled: allowed && source.kind === 'draft',
  });
  const mutation = useLowEffectMutation({
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
    mutation.isError &&
    isApiError(mutation.error) &&
    mutation.error.kind === 'problem' &&
    mutation.error.status === 412;
  let kind: DuplicateState['kind'] = 'ready';
  if (!allowed || readDenied) kind = 'denied';
  else if (mutation.isPending) kind = 'sending';
  else if (source.kind === 'draft') {
    if (draft.isPending || draft.isFetching) kind = 'loading';
    else if (draft.isError) kind = 'failed';
    else if (stale) kind = 'stale';
  }
  let error: string | undefined;
  if (readDenied)
    error =
      'Access changed. Close this dialog and check your access to the source.';
  else if (mutation.isError)
    error = stale
      ? 'The saved source changed. Read the current draft, then confirm a new copy.'
      : lowEffectError(mutation.error, 'duplicating this workflow');
  else if (draft.isError)
    error = describeCommandError(draft.error, 'reading the saved source');
  const current = shownData(draft);
  const state: DuplicateState = {
    kind,
    ...(current === undefined ? {} : { draft: current }),
    error,
  };
  async function start(name: string) {
    if (state.kind !== 'ready') return;
    try {
      await mutation.mutateAsync(
        {
          body: { name, source },
          ...(draft.data === undefined ? {} : { etag: draft.data.etag }),
        },
        {
          onSuccess: (result) => {
            const read = cache.getQueryState([
              ...workflowKeys.detail(userId, workspaceId, workflowId),
              'duplicate-draft',
            ]);
            if (!deniedRead.current && !isAccessLost(read?.error))
              onCreated(result.workflowId);
          },
        },
      );
    } catch {
      /* The mutation owns the displayed failure. */
    }
  }
  return {
    state,
    start,
    refresh: () => {
      mutation.reset();
      void draft.refetch();
    },
  };
}
