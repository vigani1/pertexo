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
import { ADMINISTRATORS } from '@/features/workspaces/roles.public';

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
  const organization = useOrganizationReads({
    apiClient,
    userId,
    workspaceId: workspace.id,
    selected,
    enabled,
  });
  const locked =
    preparing ||
    command.pending ||
    command.retryAvailable ||
    audience.pending ||
    audience.review !== undefined;
  const feedback =
    command.error ??
    readError ??
    (organization.failedRead
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
        ...organization.reads.map((read) =>
          read.refetch({ throwOnError: true }),
        ),
        organization.folders.refetch({ throwOnError: true }),
        organization.tags.refetch({ throwOnError: true }),
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
            : `Only ${ADMINISTRATORS} may move archived workflows.`,
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
    ...organization,
    selected,
    selectionValid,
    command,
    locked,
    feedback,
    preparing,
    formEpoch,
    refresh,
    confirm,
    audience,
  };
}

function useOrganizationReads({
  apiClient,
  userId,
  workspaceId,
  selected,
  enabled,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  selected: readonly WorkflowOrganizationProjectionResponse[];
  enabled: boolean;
}>) {
  const reads = useQueries({
    queries: selected.map(({ workflow }) => ({
      ...workflowOrganizationProjectionQueryOptions({
        api: apiClient,
        userId,
        workspaceId: workspaceId,
        workflowId: workflow.id,
        input: { include: 'organization' },
      }),
      staleTime: 0,
      enabled,
    })),
  });
  const folders = useQuery({
    ...workflowFoldersQueryOptions(apiClient, userId, workspaceId),
    enabled,
  });
  const tags = useInfiniteQuery({
    ...workflowTagsInfiniteQueryOptions(apiClient, userId, workspaceId),
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
  return { reads, folders, tags, current, reading, failedRead };
}
