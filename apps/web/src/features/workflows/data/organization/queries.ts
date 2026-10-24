import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  workflowTagListQuerySchema,
  workflowTagAssignmentsQuerySchema,
  workflowFolderListQuerySchema,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  normalizeWorkflowOrganizationListQuery,
  normalizeWorkflowOrganizationProjectionQuery,
} from '../../model/organization/requests';
import {
  WORKFLOW_ORDER_BY_SORT,
  type WorkflowListSearch,
} from '../../model/list-view';
import {
  getWorkflowOrganizationPage,
  getWorkflowOrganizationProjection,
  getWorkflowTagsPage,
  getWorkflowTagAssignmentsPage,
  getWorkflowFolders,
} from './api';

export const workflowOrganizationKeys = {
  scope: (userId: string, workspaceId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow-organization',
    ] as const,
  folders: (userId: string, workspaceId: string, input: unknown = {}) =>
    [
      ...workflowOrganizationKeys.scope(userId, workspaceId),
      'folders',
      workflowFolderListQuerySchema.parse(input),
    ] as const,
  list: (userId: string, workspaceId: string, input: unknown = {}) =>
    [
      ...workflowOrganizationKeys.scope(userId, workspaceId),
      'list',
      normalizeWorkflowOrganizationListQuery(input),
    ] as const,
  detail: (
    userId: string,
    workspaceId: string,
    workflowId: string,
    input: unknown,
  ) =>
    [
      ...workflowOrganizationKeys.scope(userId, workspaceId),
      'detail',
      workflowId,
      normalizeWorkflowOrganizationProjectionQuery(input),
    ] as const,
  tags: (userId: string, workspaceId: string, input: unknown = {}) =>
    [
      ...workflowOrganizationKeys.scope(userId, workspaceId),
      'tags',
      { limit: 25, ...workflowTagListQuerySchema.parse(input) },
    ] as const,
  assignments: (
    userId: string,
    workspaceId: string,
    tagId: string,
    input: unknown = {},
  ) =>
    [
      ...workflowOrganizationKeys.scope(userId, workspaceId),
      'assignments',
      tagId,
      { limit: 25, ...workflowTagAssignmentsQuerySchema.parse(input) },
    ] as const,
};

export function workflowFoldersQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  input: unknown = {},
) {
  const query = workflowFolderListQuerySchema.parse(input);
  return queryOptions({
    queryKey: workflowOrganizationKeys.folders(userId, workspaceId, query),
    queryFn: ({ signal }) =>
      getWorkflowFolders(api, workspaceId, query, signal),
    retry: false,
  });
}

/** The workflow list page's read for its search. */
export function workflowListQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  search: WorkflowListSearch,
) {
  return workflowOrganizationInfiniteQueryOptions(api, userId, workspaceId, {
    include: 'organization',
    order: WORKFLOW_ORDER_BY_SORT[search.sort ?? 'updated'],
    view: search.view ?? 'active',
    query: search.query,
    tagId: search.tagId,
    folderId: search.folderId,
    favoritesOnly: search.favoritesOnly,
  });
}

/** Active workflows whose name holds the text, searched on the server. */
export function workflowNameSearchQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  text: string,
) {
  return workflowOrganizationInfiniteQueryOptions(api, userId, workspaceId, {
    query: text,
  });
}

export function workflowOrganizationInfiniteQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  input: unknown = {},
) {
  const query = normalizeWorkflowOrganizationListQuery(input);
  return infiniteQueryOptions({
    queryKey: workflowOrganizationKeys.list(userId, workspaceId, query),
    queryFn: async ({ pageParam, signal }) => {
      if (query.query !== undefined && pageParam === null)
        await waitForSearch(signal);
      return getWorkflowOrganizationPage(
        api,
        workspaceId,
        { ...query, after: pageParam ?? undefined },
        signal,
      );
    },
    initialPageParam: query.after ?? null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
}

export function workflowOrganizationProjectionQueryOptions({
  api,
  userId,
  workspaceId,
  workflowId,
  input,
}: Readonly<{
  api: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  input: unknown;
}>) {
  const query = normalizeWorkflowOrganizationProjectionQuery(input);
  return queryOptions({
    queryKey: workflowOrganizationKeys.detail(
      userId,
      workspaceId,
      workflowId,
      query,
    ),
    queryFn: ({ signal }) =>
      getWorkflowOrganizationProjection({
        api,
        workspaceId,
        workflowId,
        input: query,
        signal,
      }),
    retry: false,
  });
}

export function workflowTagsInfiniteQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  input: unknown = {},
) {
  const query = workflowTagListQuerySchema.parse(input);
  return infiniteQueryOptions({
    queryKey: workflowOrganizationKeys.tags(userId, workspaceId, query),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowTagsPage(
        api,
        workspaceId,
        { ...query, after: pageParam ?? undefined },
        signal,
      ),
    initialPageParam: query.after ?? null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
}

export function workflowTagAssignmentsInfiniteQueryOptions({
  api,
  userId,
  workspaceId,
  tagId,
  input = {},
}: Readonly<{
  api: ApiClient;
  userId: string;
  workspaceId: string;
  tagId: string;
  input?: unknown;
}>) {
  const query = workflowTagAssignmentsQuerySchema.parse(input);
  return infiniteQueryOptions({
    queryKey: workflowOrganizationKeys.assignments(
      userId,
      workspaceId,
      tagId,
      query,
    ),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowTagAssignmentsPage({
        api,
        workspaceId,
        tagId,
        input: { ...query, after: pageParam ?? undefined },
        signal,
      }),
    initialPageParam: query.after ?? null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
}

/** Delay only a new name search; cancelling it also cancels the pending timer. */
function waitForSearch(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Search cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 250);
    signal.addEventListener('abort', abort, { once: true });
  });
}
