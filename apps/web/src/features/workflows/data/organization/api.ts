import {
  workflowListResponseSchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowTagListQuerySchema,
  workflowTagListResponseSchema,
  workflowTagAssignmentsQuerySchema,
  workflowTagAssignmentsResponseSchema,
  workflowTagCreateResponseSchema,
  workflowTagRenameResponseSchema,
  workflowTagDeleteResponseSchema,
  workflowTagReplaceResponseSchema,
  workflowFavoriteRequestSchema,
  workflowFavoriteResponseSchema,
  workflowFolderListQuerySchema,
  workflowFolderListResponseSchema,
  workflowFolderCreateResponseSchema,
  workflowFolderRenameResponseSchema,
  workflowFolderMoveResponseSchema,
  workflowFolderDeleteResponseSchema,
  workflowFolderPlacementResponseSchema,
  workflowOrganizationBulkResponseSchema,
  workflowTagCleanupDetachResponseSchema,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import {
  normalizeWorkflowOrganizationListQuery,
  normalizeWorkflowOrganizationProjectionQuery,
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../../model/organization/requests';

function workspacePath(workspaceId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function queryString(query: object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** One bounded vocabulary read, not recursive workflow discovery. */
export function getWorkflowFolders(
  api: ApiClient,
  workspaceId: string,
  input: unknown,
  signal: AbortSignal,
) {
  workflowFolderListQuerySchema.parse(input);
  return api.request({
    path: `${workspacePath(workspaceId)}/workflow-folders`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowFolderListResponseSchema.parse(value),
    },
  });
}

export function getWorkflowOrganizationPage(
  api: ApiClient,
  workspaceId: string,
  input: unknown,
  signal: AbortSignal,
) {
  const query = normalizeWorkflowOrganizationListQuery(input);
  return api.request({
    path: `${workspacePath(workspaceId)}/workflows?${queryString(query)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) =>
        query.include === 'organization'
          ? workflowOrganizationListResponseSchema.parse(value)
          : workflowListResponseSchema.parse(value),
    },
  });
}

export function getWorkflowOrganizationProjection(
  api: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: unknown,
  signal: AbortSignal,
) {
  const query = normalizeWorkflowOrganizationProjectionQuery(input);
  return api.request({
    path: `${workspacePath(workspaceId)}/workflows/${encodeURIComponent(workflowId)}?${queryString(query)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) =>
        query.include === 'organization'
          ? workflowOrganizationProjectionResponseSchema.parse(value)
          : workflowCombinedOrganizationProjectionResponseSchema.parse(value),
    },
  });
}

export function getWorkflowTagsPage(
  api: ApiClient,
  workspaceId: string,
  input: unknown,
  signal: AbortSignal,
) {
  const query = workflowTagListQuerySchema.parse(input);
  return api.request({
    path: `${workspacePath(workspaceId)}/workflow-tags?${queryString({ limit: 25, ...query })}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTagListResponseSchema.parse(value),
    },
  });
}

export function getWorkflowTagAssignmentsPage(
  api: ApiClient,
  workspaceId: string,
  tagId: string,
  input: unknown,
  signal: AbortSignal,
) {
  const query = workflowTagAssignmentsQuerySchema.parse(input);
  return api.request({
    path: `${workspacePath(workspaceId)}/workflow-tags/${encodeURIComponent(tagId)}/workflows?${queryString({ limit: 25, ...query })}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTagAssignmentsResponseSchema.parse(value),
    },
  });
}

/** Sets the user's favorite state for one workflow; repeating it is harmless. */
export function setWorkflowFavorite(
  api: ApiClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    favorite: boolean;
  }>,
) {
  return api.request({
    method: 'PUT',
    path: `${workspacePath(input.workspaceId)}/workflows/${encodeURIComponent(input.workflowId)}/favorite`,
    body: workflowFavoriteRequestSchema.parse({ favorite: input.favorite }),
    response: {
      kind: 'json',
      decode: (value) => workflowFavoriteResponseSchema.parse(value),
    },
  });
}

/** Receipts can be historical replays; the caller must reread current projections. */
export function sendWorkflowOrganizationCommand(
  api: ApiClient,
  input: WorkflowOrganizationAttempt,
  signal: AbortSignal,
) {
  const attempt = freezeWorkflowOrganizationAttempt(input);
  const base = workspacePath(attempt.workspaceId);
  const request = {
    method: 'POST' as const,
    body: attempt.body,
    signal,
    headers: { 'Idempotency-Key': attempt.idempotencyKey },
  };
  switch (attempt.kind) {
    case 'create-tag':
      return api.request({
        ...request,
        path: `${base}/workflow-tags`,
        response: {
          kind: 'json',
          decode: (value) => workflowTagCreateResponseSchema.parse(value),
        },
      });
    case 'rename-tag':
      return api.request({
        ...request,
        path: `${base}/workflow-tags/${encodeURIComponent(attempt.tagId)}/rename`,
        response: {
          kind: 'json',
          decode: (value) => workflowTagRenameResponseSchema.parse(value),
        },
      });
    case 'delete-tag':
      return api.request({
        ...request,
        path: `${base}/workflow-tags/${encodeURIComponent(attempt.tagId)}/delete`,
        response: {
          kind: 'json',
          decode: (value) => workflowTagDeleteResponseSchema.parse(value),
        },
      });
    case 'replace-tags':
      return api.request({
        ...request,
        path: `${base}/workflows/${encodeURIComponent(attempt.workflowId)}/tags`,
        response: {
          kind: 'json',
          decode: (value) => workflowTagReplaceResponseSchema.parse(value),
        },
      });
    case 'create-folder':
      return api.request({
        ...request,
        path: `${base}/workflow-folders`,
        response: {
          kind: 'json',
          decode: (value) => workflowFolderCreateResponseSchema.parse(value),
        },
      });
    case 'rename-folder':
      return api.request({
        ...request,
        path: `${base}/workflow-folders/${encodeURIComponent(attempt.folderId)}/rename`,
        response: {
          kind: 'json',
          decode: (value) => workflowFolderRenameResponseSchema.parse(value),
        },
      });
    case 'move-folder':
      return api.request({
        ...request,
        path: `${base}/workflow-folders/${encodeURIComponent(attempt.folderId)}/move`,
        response: {
          kind: 'json',
          decode: (value) => workflowFolderMoveResponseSchema.parse(value),
        },
      });
    case 'delete-folder':
      return api.request({
        ...request,
        path: `${base}/workflow-folders/${encodeURIComponent(attempt.folderId)}/delete`,
        response: {
          kind: 'json',
          decode: (value) => workflowFolderDeleteResponseSchema.parse(value),
        },
      });
    case 'place-folder':
      return api.request({
        ...request,
        path: `${base}/workflows/${encodeURIComponent(attempt.workflowId)}/folder`,
        response: {
          kind: 'json',
          decode: (value) => workflowFolderPlacementResponseSchema.parse(value),
        },
      });
    case 'bulk':
      return api.request({
        ...request,
        path: `${base}/workflows/organization/bulk`,
        response: {
          kind: 'json',
          decode: (value) => {
            const response =
              workflowOrganizationBulkResponseSchema.parse(value);
            if (
              response.items.length !== attempt.body.items.length ||
              response.items.some(
                (item, index) =>
                  item.workflowId !== attempt.body.items[index]?.workflowId,
              )
            )
              throw new Error(
                'Bulk outcomes do not match the submitted ordered selection',
              );
            return response;
          },
        },
      });
    case 'tag-cleanup':
      return api.request({
        ...request,
        path: `${base}/workflow-tags/cleanup/detach`,
        response: {
          kind: 'json',
          decode: (value) => {
            const response =
              workflowTagCleanupDetachResponseSchema.parse(value);
            if (
              response.items.length !== attempt.body.items.length ||
              response.items.some(
                (item, index) =>
                  item.workflowId !== attempt.body.items[index]?.workflowId,
              )
            )
              throw new Error(
                'Cleanup outcomes do not match the submitted ordered selection',
              );
            return response;
          },
        },
      });
  }
}
