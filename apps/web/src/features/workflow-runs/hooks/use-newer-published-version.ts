import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { workflowRunVersionQueryOptions } from '../data/detail.queries';

/**
 * The published version when it isn't the one this run used: what a person
 * reprocessing a failed run usually wants after fixing it.
 */
export function useNewerPublishedVersion({
  apiClient,
  userId,
  workspace,
  source,
  enabled,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: Pick<AccessibleWorkspace, 'id' | 'capabilities'>;
  source: Readonly<{ workflowId: string; workflowVersionId: string }>;
  enabled: boolean;
}>) {
  const readable = enabled && workspace.capabilities.includes('workflow:read');
  const workflow = useQuery({
    ...workflowSummaryQueryOptions(
      apiClient,
      userId,
      workspace.id,
      source.workflowId,
    ),
    enabled: readable,
  });
  const publishedId = workflow.data?.publishedVersionId;
  const differs =
    typeof publishedId === 'string' && publishedId !== source.workflowVersionId;
  const version = useQuery({
    ...workflowRunVersionQueryOptions({
      apiClient,
      userId,
      workspaceId: workspace.id,
      workflowId: source.workflowId,
      versionId: differs ? publishedId : source.workflowVersionId,
    }),
    enabled: readable && differs,
  });
  return {
    /** Still finding out; the source version isn't yet known to be the choice. */
    pending: readable && (workflow.isPending || (differs && version.isPending)),
    newer:
      differs && version.data !== undefined
        ? { id: version.data.id, versionNumber: version.data.versionNumber }
        : undefined,
  };
}
