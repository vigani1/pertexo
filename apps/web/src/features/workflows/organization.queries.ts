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
} from './model/workflow-organization';
import {
  getWorkflowOrganizationPage,
  getWorkflowOrganizationProjection,
  getWorkflowTagsPage,
  getWorkflowTagAssignmentsPage,
  getWorkflowFolders,
} from './organization.api';

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

export function workflowOrganizationInfiniteQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  input: unknown = {},
) {
  const query = normalizeWorkflowOrganizationListQuery(input);
  return infiniteQueryOptions({
    queryKey: workflowOrganizationKeys.list(userId, workspaceId, query),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowOrganizationPage(
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

export function workflowOrganizationProjectionQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  input: unknown,
) {
  const query = normalizeWorkflowOrganizationProjectionQuery(input);
  return queryOptions({
    queryKey: workflowOrganizationKeys.detail(
      userId,
      workspaceId,
      workflowId,
      query,
    ),
    queryFn: ({ signal }) =>
      getWorkflowOrganizationProjection(
        api,
        workspaceId,
        workflowId,
        query,
        signal,
      ),
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

export function workflowTagAssignmentsInfiniteQueryOptions(
  api: ApiClient,
  userId: string,
  workspaceId: string,
  tagId: string,
  input: unknown = {},
) {
  const query = workflowTagAssignmentsQuerySchema.parse(input);
  return infiniteQueryOptions({
    queryKey: workflowOrganizationKeys.assignments(
      userId,
      workspaceId,
      tagId,
      query,
    ),
    queryFn: ({ pageParam, signal }) =>
      getWorkflowTagAssignmentsPage(
        api,
        workspaceId,
        tagId,
        { ...query, after: pageParam ?? undefined },
        signal,
      ),
    initialPageParam: query.after ?? null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
}
