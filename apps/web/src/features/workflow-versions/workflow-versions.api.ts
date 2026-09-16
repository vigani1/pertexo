import {
  strongEtagSchema,
  workflowVersionRestoreRequestSchema,
  workflowVersionsResponseSchema,
  type WorkflowVersionResponse,
  type WorkflowVersionsResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  decodeWorkflowDraftSnapshot,
  type WorkflowDraftSnapshot,
} from '@/features/workflow-drafts/public';
import type { ApiClient } from '@/lib/api/client';

function versionsPath(workspaceId: string, workflowId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/versions` as const;
}

function getWorkflowVersionsPage(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{ after?: string; signal?: AbortSignal }> = {},
): Promise<WorkflowVersionsResponse> {
  const query = new URLSearchParams({ limit: '25' });
  if (input.after !== undefined) query.set('after', input.after);
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowVersionsResponseSchema.parse(value),
    },
  });
}

export async function getAllWorkflowVersions(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowVersionsResponse> {
  const items: WorkflowVersionResponse[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const response = await getWorkflowVersionsPage(
      apiClient,
      workspaceId,
      workflowId,
      {
        ...(after === undefined ? {} : { after }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    items.push(...response.items);
    if (response.nextCursor === null) return { items, nextCursor: null };
    if (seen.has(response.nextCursor))
      throw new Error('Workflow version pagination repeated a cursor.');
    seen.add(response.nextCursor);
    after = response.nextCursor;
  }
  throw new Error(
    'Workflow version discovery exceeded its bounded page limit.',
  );
}

export async function findWorkflowVersion(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<WorkflowVersionResponse> {
  let after: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 40; page += 1) {
    const response = await getWorkflowVersionsPage(
      apiClient,
      workspaceId,
      workflowId,
      {
        ...(after === undefined ? {} : { after }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const version = response.items.find((item) => item.id === versionId);
    if (version !== undefined) return version;
    if (response.nextCursor === null) break;
    if (seen.has(response.nextCursor))
      throw new Error('Workflow version pagination repeated a cursor.');
    seen.add(response.nextCursor);
    after = response.nextCursor;
  }
  throw new Error(
    'The workflow version lookup exceeded its bounded result set.',
  );
}

export function restoreWorkflowVersion(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  versionId: string,
  etag: string,
): Promise<WorkflowDraftSnapshot> {
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}/${encodeURIComponent(versionId)}/restore`,
    method: 'POST',
    headers: { 'If-Match': strongEtagSchema.parse(etag) },
    body: workflowVersionRestoreRequestSchema.parse({}),
    response: {
      kind: 'json',
      decode: (value, metadata) =>
        decodeWorkflowDraftSnapshot(value, metadata.header('etag')),
    },
  });
}
