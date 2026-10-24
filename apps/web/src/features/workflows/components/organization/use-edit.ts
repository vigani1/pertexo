import { useAudienceMove } from '../../hooks/use-audience-move';
import { useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowOrganizationProjectionResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  workflowFoldersQueryOptions,
  workflowOrganizationProjectionQueryOptions,
  workflowTagsInfiniteQueryOptions,
} from '../../data/organization/queries';
import { useWorkflowOrganizationCommand } from '../../hooks/use-workflow-organization-command';
import {
  canEditOrganization,
  organizationEditAttempt,
  validOrganizationSelection,
  type OrganizationOperation,
} from './editing';

export type Props = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflows: readonly WorkflowOrganizationProjectionResponse[];
  onClose: () => void;
}>;

export function useOrganizationEdit({
  apiClient,
  userId,
  workspace,
  workflows,
}: Omit<Props, 'onClose'>) {
  const [selected] = useState(() => [...workflows]);
  const selectionValid = validOrganizationSelection(selected);
  const queryClient = useQueryClient();
  const [preparing, setPreparing] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [formEpoch, setFormEpoch] = useState(0);
  const preparingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const command = useWorkflowOrganizationCommand({
    apiClient,
    userId,
    workspace,
    requiredRole: 'editor',
  });
  const audience = useAudienceMove(apiClient, workspace.id, (attempt) =>
    command.start(attempt),
  );
  const enabled = selectionValid && !command.denied;
  const reads = useQueries({
    queries: selected.map(({ workflow }) => ({
      ...workflowOrganizationProjectionQueryOptions({
        api: apiClient,
        userId,
        workspaceId: workspace.id,
        workflowId: workflow.id,
        input: { include: 'organization' },
      }),
      staleTime: 0,
      enabled,
    })),
  });
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspace.id),
    enabled,
  });
  const tags = useInfiniteQuery({
    ...workflowTagsInfiniteQueryOptions(apiClient, userId, workspace.id),
    enabled,
  });
  const current = reads.flatMap((read) =>
    read.data === undefined ? [] : [read.data],
  );
  const reading =
    reads.some((read) => read.isPending || read.isFetching) ||
    folders.isPending ||
    tags.isPending;
  const failedRead =
    reads.some((read) => read.isError) || folders.isError || tags.isError;
  const locked =
    preparing ||
    command.pending ||
    command.retryAvailable ||
    audience.pending ||
    audience.review !== undefined;
  const feedback =
    command.error ??
    readError ??
    (failedRead
      ? 'Current organization could not be loaded. Refresh before confirming a change.'
      : undefined);

  async function refresh() {
    if (preparingRef.current || command.pending || command.denied) return;
    if (!command.retryAvailable) command.reset();
    setReadError(undefined);
    setPreparing(true);
    preparingRef.current = true;
    try {
      await Promise.all([
        ...reads.map((read) => read.refetch({ throwOnError: true })),
        folders.refetch({ throwOnError: true }),
        tags.refetch({ throwOnError: true }),
      ]);
      if (alive.current) setFormEpoch((epoch) => epoch + 1);
    } catch {
      if (alive.current)
        setReadError(
          'Current organization could not be refreshed. No new command was sent.',
        );
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(false);
    }
  }

  async function confirm(
    operation: OrganizationOperation,
    folderId: string | null,
    tagIds: readonly string[],
  ) {
    const organizationPreparationBlocked =
      locked ||
      preparingRef.current ||
      command.denied ||
      command.error !== undefined ||
      command.result !== undefined;
    if (organizationPreparationBlocked) return;
    preparingRef.current = true;
    setPreparing(true);
    setReadError(undefined);
    try {
      const latest = await Promise.all(
        selected.map(({ workflow }) =>
          queryClient.query({
            ...workflowOrganizationProjectionQueryOptions({
              api: apiClient,
              userId,
              workspaceId: workspace.id,
              workflowId: workflow.id,
              input: { include: 'organization' },
            }),
            staleTime: 0,
          }),
        ),
      );
      if (!alive.current) return;
      if (!canEditOrganization(workspace, latest, operation)) {
        setReadError(
          operation === 'replace_tags'
            ? 'Tags can be replaced only on active workflows by an editor.'
            : 'Only owners and admins may move archived workflows.',
        );
        return;
      }
      await audience.begin(
        organizationEditAttempt({
          workspaceId: workspace.id,
          workflows: latest,
          operation,
          folderId,
          tagIds,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
    } catch {
      if (alive.current)
        setReadError(
          'Current organization could not be checked. No new command was sent. Refresh before confirming again.',
        );
    } finally {
      preparingRef.current = false;
      if (alive.current) setPreparing(false);
    }
  }

  return {
    selected,
    selectionValid,
    command,
    current,
    folders,
    tags,
    reading,
    failedRead,
    locked,
    feedback,
    preparing,
    formEpoch,
    refresh,
    confirm,
    audience,
  };
}
