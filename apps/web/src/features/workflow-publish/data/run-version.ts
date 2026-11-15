import type { ApiClient } from '@/lib/api/client';
import { findWorkflowVersion } from '@/features/workflow-versions/workflow-versions-queries.public';

/**
 * The published version a run input is checked against before a file goes
 * into it: its callable contract decides whether the property fits.
 */
export function readRunVersion(
  scope: Readonly<{ apiClient: ApiClient; workspaceId: string }>,
  workflowId: string,
  versionId: string,
  signal: AbortSignal,
) {
  return findWorkflowVersion({
    apiClient: scope.apiClient,
    workspaceId: scope.workspaceId,
    workflowId,
    versionId,
    signal,
  });
}
