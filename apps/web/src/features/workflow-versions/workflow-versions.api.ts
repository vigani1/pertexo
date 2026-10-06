import {
  strongEtagSchema,
  workflowVersionRestoreRequestSchema,
  workflowVersionsResponseSchema,
  workflowCallableTargetsQuerySchema,
  workflowCallableTargetsResponseSchema,
  type WorkflowCallableTargetsResponse,
  type WorkflowVersionResponse,
  type WorkflowVersionsResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  decodeWorkflowDraftSnapshot,
  type WorkflowDraftSnapshot,
} from '@/features/workflow-drafts/public';
import type { ApiClient } from '@/lib/api/client';
import { collectPages, cursorPages } from '@/lib/api/pagination';

function versionsPath(workspaceId: string, workflowId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/versions` as const;
}

function decodeCallableTargets(
  value: unknown,
  workspaceId: string,
  workflowId: string,
): WorkflowCallableTargetsResponse {
  const response = workflowCallableTargetsResponseSchema.parse(value);
  if (
    response.workspaceId !== workspaceId ||
    response.items.some((item) => item.workflowId !== workflowId) ||
    new Set(response.items.map((item) => item.id)).size !==
      response.items.length
  )
    throw new Error(
      'Callable-target response does not match its requested scope.',
    );
  return response;
}

/** One explicitly selected workflow page; never traverses other pages or workflows. */
export function getWorkflowCallableTargetsPage(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{
    limit?: number;
    after?: string;
    signal?: AbortSignal;
  }> = {},
): Promise<WorkflowCallableTargetsResponse> {
  const parsed = workflowCallableTargetsQuerySchema.parse({
    include: 'callableTarget',
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  if (!('limit' in parsed))
    throw new Error('Expected callable-target page query.');
  const query = new URLSearchParams({
    include: parsed.include,
    limit: String(parsed.limit),
  });
  if (parsed.after !== undefined) query.set('after', parsed.after);
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => {
        const response = decodeCallableTargets(value, workspaceId, workflowId);
        if (response.items.length > parsed.limit)
          throw new Error(
            'Callable-target response exceeds the requested page size.',
          );
        return response;
      },
    },
  });
}

/** Fresh exact read for inspection/confirmation; its result is not mutation authority. */
export function getWorkflowCallableTargetVersion(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<WorkflowCallableTargetsResponse> {
  const parsed = workflowCallableTargetsQuerySchema.parse({
    include: 'callableTarget',
    versionId,
  });
  if (!('versionId' in parsed))
    throw new Error('Expected exact callable-target query.');
  const query = new URLSearchParams({
    include: parsed.include,
    versionId: parsed.versionId,
  });
  return apiClient.request({
    path: `${versionsPath(workspaceId, workflowId)}?${query.toString()}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => {
        const response = decodeCallableTargets(value, workspaceId, workflowId);
        if (
          response.nextCursor !== null ||
          response.items.length !== 1 ||
          response.items[0]?.id !== versionId
        )
          throw new Error(
            'Callable-target response does not match its requested version.',
          );
        return response;
      },
    },
  });
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

export async function findWorkflowVersion(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<WorkflowVersionResponse> {
  for await (const page of cursorPages(
    readVersionPage(apiClient, workspaceId, workflowId, signal),
    { read: 'Workflow version lookup', signal },
  )) {
    const version = page.items.find((item) => item.id === versionId);
    if (version !== undefined) return version;
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
