import {
  workflowOrganizationListQuerySchema,
  workflowOrganizationProjectionQuerySchema,
  workflowTagCreateRequestSchema,
  workflowTagDeleteRequestSchema,
  workflowTagRenameRequestSchema,
  workflowTagReplaceRequestSchema,
  workflowFavoriteRequestSchema,
  workflowFolderCreateRequestSchema,
  workflowFolderRenameRequestSchema,
  workflowFolderMoveRequestSchema,
  workflowFolderDeleteRequestSchema,
  workflowFolderPlacementRequestSchema,
  workflowOrganizationBulkRequestSchema,
  workflowTagCleanupDetachRequestSchema,
  type WorkflowTagCreateRequest,
  type WorkflowTagDeleteRequest,
  type WorkflowTagRenameRequest,
  type WorkflowTagReplaceRequest,
  type WorkflowFavoriteRequest,
  type WorkflowFolderCreateRequest,
  type WorkflowFolderRenameRequest,
  type WorkflowFolderMoveRequest,
  type WorkflowFolderDeleteRequest,
  type WorkflowFolderPlacementRequest,
  type WorkflowOrganizationBulkRequest,
  type WorkflowTagCleanupDetachRequest,
} from '@pertexo/contracts/schemas/workflow-authoring';

/** The wire contract owns literal normalization, including U+0020 and NUL. */
export function normalizeWorkflowOrganizationListQuery(input: unknown = {}) {
  const query = workflowOrganizationListQuerySchema.parse(input);
  return Object.freeze({
    limit: 25,
    order: 'updated_desc' as const,
    view: 'all' as const,
    ...query,
  });
}

export function normalizeWorkflowOrganizationProjectionQuery(input: unknown) {
  return Object.freeze(workflowOrganizationProjectionQuerySchema.parse(input));
}

type Command =
  | { kind: 'create-tag'; body: WorkflowTagCreateRequest }
  | { kind: 'rename-tag'; tagId: string; body: WorkflowTagRenameRequest }
  | { kind: 'delete-tag'; tagId: string; body: WorkflowTagDeleteRequest }
  | {
      kind: 'replace-tags';
      workflowId: string;
      body: WorkflowTagReplaceRequest;
    }
  | { kind: 'favorite'; workflowId: string; body: WorkflowFavoriteRequest }
  | { kind: 'create-folder'; body: WorkflowFolderCreateRequest }
  | {
      kind: 'rename-folder';
      folderId: string;
      body: WorkflowFolderRenameRequest;
    }
  | { kind: 'move-folder'; folderId: string; body: WorkflowFolderMoveRequest }
  | {
      kind: 'delete-folder';
      folderId: string;
      body: WorkflowFolderDeleteRequest;
    }
  | {
      kind: 'place-folder';
      workflowId: string;
      body: WorkflowFolderPlacementRequest;
    }
  | { kind: 'bulk'; body: WorkflowOrganizationBulkRequest }
  | { kind: 'tag-cleanup'; body: WorkflowTagCleanupDetachRequest };

export type WorkflowOrganizationAttempt = Readonly<
  Command & {
    workspaceId: string;
    idempotencyKey: string;
  }
>;

/** One accepted command: an uncertain retry must reuse this exact attempt. */
export function freezeWorkflowOrganizationAttempt(
  input: WorkflowOrganizationAttempt,
): WorkflowOrganizationAttempt {
  switch (input.kind) {
    case 'create-tag':
      return Object.freeze({
        ...input,
        body: Object.freeze(workflowTagCreateRequestSchema.parse(input.body)),
      });
    case 'rename-tag':
      return Object.freeze({
        ...input,
        body: Object.freeze(workflowTagRenameRequestSchema.parse(input.body)),
      });
    case 'delete-tag':
      return Object.freeze({
        ...input,
        body: Object.freeze(workflowTagDeleteRequestSchema.parse(input.body)),
      });
    case 'replace-tags': {
      const body = workflowTagReplaceRequestSchema.parse(input.body);
      Object.freeze(body.tagIds);
      return Object.freeze({ ...input, body: Object.freeze(body) });
    }
    case 'favorite':
      return Object.freeze({
        ...input,
        body: Object.freeze(workflowFavoriteRequestSchema.parse(input.body)),
      });
    case 'create-folder':
      return Object.freeze({
        ...input,
        body: Object.freeze(
          workflowFolderCreateRequestSchema.parse(input.body),
        ),
      });
    case 'rename-folder':
      return Object.freeze({
        ...input,
        body: Object.freeze(
          workflowFolderRenameRequestSchema.parse(input.body),
        ),
      });
    case 'move-folder':
      return Object.freeze({
        ...input,
        body: Object.freeze(workflowFolderMoveRequestSchema.parse(input.body)),
      });
    case 'delete-folder':
      return Object.freeze({
        ...input,
        body: Object.freeze(
          workflowFolderDeleteRequestSchema.parse(input.body),
        ),
      });
    case 'place-folder':
      return Object.freeze({
        ...input,
        body: Object.freeze(
          workflowFolderPlacementRequestSchema.parse(input.body),
        ),
      });
    case 'bulk': {
      const body = workflowOrganizationBulkRequestSchema.parse(input.body);
      for (const item of body.items) Object.freeze(item);
      Object.freeze(body.items);
      if (body.operation === 'replace_tags') Object.freeze(body.tagIds);
      return Object.freeze({ ...input, body: Object.freeze(body) });
    }
    case 'tag-cleanup': {
      const body = workflowTagCleanupDetachRequestSchema.parse(input.body);
      for (const item of body.items) Object.freeze(item);
      Object.freeze(body.items);
      return Object.freeze({ ...input, body: Object.freeze(body) });
    }
  }
}
