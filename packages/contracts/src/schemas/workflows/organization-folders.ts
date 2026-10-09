import { z } from 'zod';
import { trimSpaces, utf8ByteLength } from '../shared/text.js';
import { strictlyAscendingIdentifiers } from './organization-order.js';
import {
  workflowOrganizationRevisionSchema,
  workflowTagReplaceRequestSchema,
} from './organization.js';

export const WORKFLOW_FOLDER_LIMITS = Object.freeze({
  nameBytes: 128,
  depth: 4,
  foldersPerWorkspace: 256,
  bulkItems: 50,
});

/** Display casing is retained. Sibling identity is an internal server concern. */
export function normalizeWorkflowFolderName(name: string): string {
  return trimSpaces(name);
}
export const workflowFolderNameSchema = z
  .string()
  .min(1)
  .max(WORKFLOW_FOLDER_LIMITS.nameBytes)
  // ADR064 deliberately rejects the entire C0 range and DEL in wire names.
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$(?![\s\S])/u)
  .refine((name) => normalizeWorkflowFolderName(name) === name)
  .refine((name) => utf8ByteLength(name) <= WORKFLOW_FOLDER_LIMITS.nameBytes);
export const workflowFolderNameInputSchema = z
  .string()
  .overwrite(normalizeWorkflowFolderName)
  .pipe(workflowFolderNameSchema)
  .describe(
    'Trim only outer U+0020; retain display casing. Runtime validation requires 1–128 UTF-8 bytes after trimming and rejects C0 controls and DEL.',
  );
export const workflowFolderRevisionSchema =
  workflowOrganizationRevisionSchema.clone();
const identifier = z.uuid().overwrite((id) => id.toLowerCase());
const canonicalIdentifier = z
  .uuid()
  .length(36)
  .regex(/^[0-9a-f-]+$(?![\s\S])/u);
export const workflowOrganizationFolderFilterSchema = z.union([
  identifier,
  z.literal('root'),
]);
export const workflowFolderWorkspaceParamsSchema = z
  .object({ workspaceId: identifier })
  .strict();
export const workflowFolderParamsSchema =
  workflowFolderWorkspaceParamsSchema.extend({
    folderId: identifier,
  });
export const workflowFolderListQuerySchema = z.object({}).strict();
export const workflowFolderSchema = z
  .object({
    id: canonicalIdentifier,
    name: workflowFolderNameSchema,
    parentId: canonicalIdentifier.nullable(),
    revision: workflowFolderRevisionSchema,
    depth: z.number().int().min(1).max(WORKFLOW_FOLDER_LIMITS.depth),
  })
  .strict()
  .refine((folder) =>
    folder.parentId === null ? folder.depth === 1 : folder.depth > 1,
  );
export const workflowFolderListResponseSchema = z
  .object({
    items: z
      .array(workflowFolderSchema)
      .max(WORKFLOW_FOLDER_LIMITS.foldersPerWorkspace)
      .refine((items) =>
        strictlyAscendingIdentifiers(items.map((item) => item.id)),
      ),
  })
  .strict();
export const workflowFolderCreateRequestSchema = z
  .object({
    name: workflowFolderNameInputSchema,
    parentId: identifier.nullable(),
  })
  .strict();
export const workflowFolderRenameRequestSchema = z
  .object({
    name: workflowFolderNameInputSchema,
    expectedFolderRevision: workflowFolderRevisionSchema,
  })
  .strict();
export const workflowFolderMoveRequestSchema = z
  .object({
    parentId: identifier.nullable(),
    expectedFolderRevision: workflowFolderRevisionSchema,
  })
  .strict();
export const workflowFolderDeleteRequestSchema = z
  .object({ expectedFolderRevision: workflowFolderRevisionSchema })
  .strict();
export const workflowFolderCreateResponseSchema = z
  .object({ folder: workflowFolderSchema, replayed: z.boolean() })
  .strict();
export const workflowFolderRenameResponseSchema =
  workflowFolderCreateResponseSchema.clone();
export const workflowFolderMoveResponseSchema =
  workflowFolderCreateResponseSchema.clone();
export const workflowFolderDeleteResponseSchema = z
  .object({
    folderId: canonicalIdentifier,
    deleted: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();
export const workflowFolderPlacementRequestSchema = z
  .object({
    folderId: identifier.nullable(),
    expectedOrganizationRevision: workflowOrganizationRevisionSchema,
  })
  .strict();
export const workflowFolderPlacementResponseSchema = z
  .object({
    workflowId: canonicalIdentifier,
    folderId: canonicalIdentifier.nullable(),
    organizationRevision: workflowOrganizationRevisionSchema,
    replayed: z.boolean(),
  })
  .strict();

export const workflowOrganizationBulkItemSchema = z
  .object({
    workflowId: identifier,
    expectedOrganizationRevision: workflowOrganizationRevisionSchema,
  })
  .strict();
const items = z
  .array(workflowOrganizationBulkItemSchema)
  .min(1)
  .max(WORKFLOW_FOLDER_LIMITS.bulkItems)
  .refine(
    (values) =>
      new Set(values.map((item) => item.workflowId)).size === values.length,
  );
export const workflowOrganizationBulkRequestSchema = z.discriminatedUnion(
  'operation',
  [
    z
      .object({
        operation: z.literal('move'),
        folderId: identifier.nullable(),
        items,
      })
      .strict(),
    z
      .object({
        operation: z.literal('replace_tags'),
        tagIds: workflowTagReplaceRequestSchema.shape.tagIds,
        items,
      })
      .strict(),
  ],
);
export const workflowOrganizationBulkConflictCodeSchema = z.enum([
  'workflow.organization_revision_conflict',
  'request.idempotency_conflict',
  'workflow.lifecycle_conflict',
  'workflow.folder_not_visible',
]);
const itemIdentity = { workflowId: canonicalIdentifier };
export const workflowOrganizationBulkItemOutcomeSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        ...itemIdentity,
        status: z.literal('updated'),
        organizationRevision: workflowOrganizationRevisionSchema,
        replayed: z.boolean(),
      })
      .strict(),
    z.object({ ...itemIdentity, status: z.literal('not_visible') }).strict(),
    z
      .object({
        ...itemIdentity,
        status: z.literal('conflict'),
        code: workflowOrganizationBulkConflictCodeSchema,
      })
      .strict(),
    z
      .object({ ...itemIdentity, status: z.literal('outcome_unknown') })
      .strict(),
    z.object({ ...itemIdentity, status: z.literal('forbidden') }).strict(),
    z.object({ ...itemIdentity, status: z.literal('not_processed') }).strict(),
  ],
);
export const workflowOrganizationBulkResponseSchema = z
  .object({
    items: z
      .array(workflowOrganizationBulkItemOutcomeSchema)
      .min(1)
      .max(WORKFLOW_FOLDER_LIMITS.bulkItems)
      .refine(
        (values) =>
          new Set(values.map((item) => item.workflowId)).size === values.length,
      )
      .refine((values) => {
        let forbidden = false;
        for (const item of values) {
          if (forbidden && item.status !== 'not_processed') return false;
          if (!forbidden && item.status === 'not_processed') return false;
          if (item.status === 'forbidden') forbidden = true;
        }
        return true;
      }),
  })
  .strict();

export type WorkflowFolder = z.output<typeof workflowFolderSchema>;
export type WorkflowFolderWorkspaceParams = z.output<
  typeof workflowFolderWorkspaceParamsSchema
>;
export type WorkflowFolderParams = z.output<typeof workflowFolderParamsSchema>;
export type WorkflowFolderListQuery = z.output<
  typeof workflowFolderListQuerySchema
>;
export type WorkflowFolderListResponse = z.output<
  typeof workflowFolderListResponseSchema
>;
export type WorkflowFolderCreateRequest = z.output<
  typeof workflowFolderCreateRequestSchema
>;
export type WorkflowFolderCreateResponse = z.output<
  typeof workflowFolderCreateResponseSchema
>;
export type WorkflowFolderRenameRequest = z.output<
  typeof workflowFolderRenameRequestSchema
>;
export type WorkflowFolderRenameResponse = z.output<
  typeof workflowFolderRenameResponseSchema
>;
export type WorkflowFolderMoveRequest = z.output<
  typeof workflowFolderMoveRequestSchema
>;
export type WorkflowFolderMoveResponse = z.output<
  typeof workflowFolderMoveResponseSchema
>;
export type WorkflowFolderDeleteRequest = z.output<
  typeof workflowFolderDeleteRequestSchema
>;
export type WorkflowFolderDeleteResponse = z.output<
  typeof workflowFolderDeleteResponseSchema
>;
export type WorkflowFolderPlacementRequest = z.output<
  typeof workflowFolderPlacementRequestSchema
>;
export type WorkflowFolderPlacementResponse = z.output<
  typeof workflowFolderPlacementResponseSchema
>;
export type WorkflowOrganizationBulkItem = z.output<
  typeof workflowOrganizationBulkItemSchema
>;
export type WorkflowOrganizationBulkRequest = z.output<
  typeof workflowOrganizationBulkRequestSchema
>;
export type WorkflowOrganizationBulkResponse = z.output<
  typeof workflowOrganizationBulkResponseSchema
>;
export type WorkflowOrganizationBulkItemOutcome = z.output<
  typeof workflowOrganizationBulkItemOutcomeSchema
>;
export type WorkflowOrganizationBulkConflictCode = z.output<
  typeof workflowOrganizationBulkConflictCodeSchema
>;
export type WorkflowOrganizationFolderFilter = z.output<
  typeof workflowOrganizationFolderFilterSchema
>;
