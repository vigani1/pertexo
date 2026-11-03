import {
  workflowExportRequestSchema,
  workflowImportPreviewRequestSchema,
  workflowImportPreviewResponseSchema,
  workflowImportRequestSchema,
  workflowImportResponseSchema,
  type WorkflowExportRequest,
  type WorkflowImportPreviewRequest,
  type WorkflowImportRequest,
  strongEtagSchema,
  workflowDraftResponseSchema,
} from '@pertexo/contracts';
import { workflowPortableManifestSchema } from '@pertexo/workflow-model';
import { findWorkflowVersion } from '@/features/workflow-versions/public';
import type { ApiClient } from '@/lib/api/client';

function base(workspaceId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows`;
}

export async function readWorkflowExportSource({
  apiClient,
  workspaceId,
  workflowId,
  source,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  source: WorkflowExportRequest['source'];
  signal: AbortSignal;
}>) {
  if (source.kind === 'version') {
    const version = await findWorkflowVersion({
      apiClient,
      workspaceId,
      workflowId,
      versionId: source.versionId,
      signal,
    });
    return {
      graph: version.graph,
      label: `Exports v${String(version.versionNumber)} exactly as it was published`,
    };
  }
  return apiClient.request({
    path: `${base(workspaceId)}/${encodeURIComponent(workflowId)}/draft`,
    signal,
    response: {
      kind: 'json',
      decode: (value, metadata) => {
        const draft = workflowDraftResponseSchema.parse(value);
        return {
          graph: draft.graph,
          etag: strongEtagSchema.parse(metadata.header('etag')),
          label: `Exports the draft as last saved, revision ${String(draft.revision)}`,
        };
      },
    },
  });
}

export function exportWorkflow({
  apiClient,
  workspaceId,
  workflowId,
  body,
  etag,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  body: WorkflowExportRequest;
  etag: string | undefined;
  signal: AbortSignal;
}>) {
  return apiClient.request({
    path: `${base(workspaceId)}/${encodeURIComponent(workflowId)}/export`,
    method: 'POST',
    body: workflowExportRequestSchema.parse(body),
    signal,
    headers:
      body.source.kind === 'draft'
        ? { 'If-Match': strongEtagSchema.parse(etag) }
        : {},
    response: {
      kind: 'json',
      decode: (value) => workflowPortableManifestSchema.parse(value),
    },
  });
}

export function previewWorkflowImport(
  apiClient: ApiClient,
  workspaceId: string,
  body: WorkflowImportPreviewRequest,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: `${base(workspaceId)}/import/preview`,
    method: 'POST',
    body: workflowImportPreviewRequestSchema.parse(body),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowImportPreviewResponseSchema.parse(value),
    },
  });
}

export function importWorkflow({
  apiClient,
  workspaceId,
  body,
  idempotencyKey,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  body: WorkflowImportRequest;
  idempotencyKey: string;
  signal: AbortSignal;
}>) {
  return apiClient.request({
    path: `${base(workspaceId)}/import`,
    method: 'POST',
    body: workflowImportRequestSchema.parse(body),
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowImportResponseSchema.parse(value),
    },
  });
}
