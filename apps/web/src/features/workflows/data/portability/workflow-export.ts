import type { WorkflowExportRequest } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  exportWorkflow,
  readWorkflowExportSource,
} from './workflow-portability.api';

type ExportTarget = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  signal: AbortSignal;
}>;

/** The saved graph an export reviews: the draft, or one published version. */
export function readExportSource(
  target: ExportTarget & Readonly<{ versionId: string | undefined }>,
) {
  const { versionId, ...rest } = target;
  return readWorkflowExportSource({
    ...rest,
    source:
      versionId === undefined
        ? { kind: 'draft' }
        : { kind: 'version', versionId },
  });
}

/**
 * Exports exactly the reviewed source: its digest, and for a draft its tag,
 * make the server refuse an export of a graph that changed since review.
 */
export function exportReviewedWorkflow(
  target: ExportTarget &
    Readonly<{
      source: WorkflowExportRequest['source'];
      review: Readonly<{ digest: string; etag?: string }>;
    }>,
) {
  const { source, review, ...rest } = target;
  return exportWorkflow({
    ...rest,
    body: { source, reviewedGraphDigest: review.digest },
    etag: review.etag,
  });
}
