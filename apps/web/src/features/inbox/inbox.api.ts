import {
  workspaceInboxListQuerySchema,
  workspaceInboxListResponseSchema,
  workspaceInboxReadAllRequestSchema,
  workspaceInboxReadAllResponseSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxSummaryResponseSchema,
  type WorkspaceInboxFilter,
  type WorkspaceInboxListResponse,
  type WorkspaceInboxReadAllResponse,
  type WorkspaceInboxReadResponse,
  type WorkspaceInboxSummaryResponse,
} from '@pertexo/contracts';
import type { ApiByteStream, ApiClient } from '@/lib/api/client';
import { searchParams } from '@/lib/api/pagination';

const inboxPath = (workspaceId: string): `/v1${string}` =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/notifications`;

/** A page of failing workflows, newest failure first. */
export function getInboxThreads(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    filter: WorkspaceInboxFilter;
    after?: string;
    signal?: AbortSignal;
  }>,
): Promise<WorkspaceInboxListResponse> {
  const query = workspaceInboxListQuerySchema.parse({
    filter: input.filter,
    limit: 25,
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  return apiClient.request({
    path: `${inboxPath(workspaceId)}?${searchParams(query)}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workspaceInboxListResponseSchema.parse(value),
    },
  });
}

export function getInboxSummary(
  apiClient: ApiClient,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceInboxSummaryResponse> {
  return apiClient.request({
    path: `${inboxPath(workspaceId)}/summary`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workspaceInboxSummaryResponseSchema.parse(value),
    },
  });
}

/** Marks one workflow's notice read up to the revision the person saw. */
export function markInboxThreadRead(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  revision: string,
): Promise<WorkspaceInboxReadResponse> {
  return apiClient.request({
    path: `${inboxPath(workspaceId)}/${encodeURIComponent(workflowId)}/read`,
    method: 'POST',
    body: workspaceInboxReadRequestSchema.parse({ revision }),
    response: {
      kind: 'json',
      decode: (value) => workspaceInboxReadResponseSchema.parse(value),
    },
  });
}

/** Marks every notice up to the revision the person saw; newer ones stay. */
export function markInboxRead(
  apiClient: ApiClient,
  workspaceId: string,
  revision: string,
): Promise<WorkspaceInboxReadAllResponse> {
  return apiClient.request({
    path: `${inboxPath(workspaceId)}/read-all`,
    method: 'POST',
    body: workspaceInboxReadAllRequestSchema.parse({ revision }),
    response: {
      kind: 'json',
      decode: (value) => workspaceInboxReadAllResponseSchema.parse(value),
    },
  });
}

/** The workspace's live hint stream; hints carry no notice content. */
export function openInboxEvents(
  apiClient: ApiClient,
  workspaceId: string,
  signal: AbortSignal,
): Promise<ApiByteStream> {
  return apiClient.stream({
    path: `${inboxPath(workspaceId)}/events`,
    signal,
    response: { kind: 'stream', mediaType: 'text/event-stream' },
  });
}
