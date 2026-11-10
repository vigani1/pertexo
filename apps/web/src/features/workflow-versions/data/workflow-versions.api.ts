import {
  strongEtagSchema,
  workflowVersionRestoreRequestSchema,
  workflowVersionRestoreResponseSchema,
  workflowVersionsResponseSchema,
  workflowVersionResponseSchema,
  type WorkflowVersionsResponse,
} from '@pertexo/contracts';
import {
  decodeWorkflowDraftSnapshot,
  type WorkflowDraftSnapshot,
} from '@/features/workflow-drafts/public';
import type { ApiClient } from '@/lib/api/client';
import { collectPages } from '@/lib/api/pagination';

const reviewedVersionsSchema = workflowVersionsResponseSchema.extend({
  items: workflowVersionResponseSchema
    .required({ graphDigest: true })
    .array()
    .max(100),
});

function versionsPath(workspaceId: string, workflowId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/versions` as const;
}

export function getWorkflowVersionsPage(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{
    after?: string;
    versionId?: string;
    signal?: AbortSignal;
  }> = {},
) {
  const query = new URLSearchParams({ limit: '25', include: 'graphDigest' });
  if (input.after !== undefined) query.set('after', input.after);
  if (input.versionId !== undefined) query.set('versionId', input.versionId);
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => reviewedVersionsSchema.parse(value),
    },
  });
}

function readVersionPage(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal: AbortSignal | undefined,
) {
  return (after: string | undefined) =>
    getWorkflowVersionsPage(apiClient, workspaceId, workflowId, {
      ...(after === undefined ? {} : { after }),
      ...(signal === undefined ? {} : { signal }),
    });
}

export async function getAllWorkflowVersions(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowVersionsResponse> {
  const items = await collectPages(
    readVersionPage(apiClient, workspaceId, workflowId, signal),
    {
      read: 'Workflow version discovery',
      signal,
    },
  );
  return { items: [...items], nextCursor: null };
}

export async function findWorkflowVersion({
  apiClient,
  workspaceId,
  workflowId,
  versionId,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  signal?: AbortSignal | undefined;
}>) {
  const page = await getWorkflowVersionsPage(
    apiClient,
    workspaceId,
    workflowId,
    {
      versionId,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const version = page.items.find((item) => item.id === versionId);
  if (version === undefined)
    throw new Error('The published workflow version is unavailable.');
  return version;
}

export function restoreWorkflowVersion({
  apiClient,
  workspaceId,
  workflowId,
  versionId,
  etag,
  idempotencyKey,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  versionId: string;
  etag: string;
  idempotencyKey: string;
}>): Promise<
  WorkflowDraftSnapshot & Readonly<{ recoveryCopyId: string | null }>
> {
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}/${encodeURIComponent(versionId)}/restore`,
    method: 'POST',
    headers: {
      'If-Match': strongEtagSchema.parse(etag),
      'Idempotency-Key': idempotencyKey,
    },
    body: workflowVersionRestoreRequestSchema.parse({}),
    response: {
      kind: 'json',
      decode: (value, metadata) => {
        const { recoveryCopyId, ...draft } =
          workflowVersionRestoreResponseSchema.parse(value);
        return {
          ...decodeWorkflowDraftSnapshot(draft, metadata.header('etag')),
          recoveryCopyId,
        };
      },
    },
  });
}
