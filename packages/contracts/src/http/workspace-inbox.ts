import { z } from 'zod';

/** ADR 054: identifier-only failure notices, not external-alert payloads. */
export const workspaceInboxFailureKindSchema = z.enum([
  'failed',
  'timed_out',
  'outcome_unknown',
]);
export const workspaceInboxTimestampSchema = z.iso.datetime({ precision: 6 });
/** PostgreSQL bigint revisions stay decimal strings across the wire. */
export const workspaceInboxRevisionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/u);
export const workspaceInboxCursorSchema = z.string().min(1).max(1_024);
export const workspaceInboxFilterSchema = z.enum(['all', 'unread']);
export const workspaceInboxLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100);
export const workspaceInboxListQuerySchema = z
  .object({
    filter: workspaceInboxFilterSchema.optional(),
    limit: workspaceInboxLimitSchema.optional(),
    after: workspaceInboxCursorSchema.optional(),
  })
  .strict();
export const workspaceInboxEntrySchema = z
  .object({
    id: z.uuid(),
    kind: workspaceInboxFailureKindSchema,
    runId: z.uuid(),
    workflowId: z.uuid(),
    occurredAt: workspaceInboxTimestampSchema,
    createdAt: workspaceInboxTimestampSchema,
    expiresAt: workspaceInboxTimestampSchema,
    readAt: workspaceInboxTimestampSchema.nullable(),
  })
  .strict();
export const workspaceInboxListResponseSchema = z
  .object({
    items: z.array(workspaceInboxEntrySchema).max(100),
    nextCursor: workspaceInboxCursorSchema.nullable(),
    revision: workspaceInboxRevisionSchema,
  })
  .strict();
export const workspaceInboxSummaryResponseSchema = z
  .object({
    unreadCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    revision: workspaceInboxRevisionSchema,
  })
  .strict();
export const workspaceInboxReadRequestSchema = z.object({}).strict();
export const workspaceInboxReadResponseSchema = z
  .object({
    entry: workspaceInboxEntrySchema,
    revision: workspaceInboxRevisionSchema,
  })
  .strict();

export type WorkspaceInboxEntry = z.infer<typeof workspaceInboxEntrySchema>;
export type WorkspaceInboxListQuery = z.infer<
  typeof workspaceInboxListQuerySchema
>;
export type WorkspaceInboxListResponse = z.infer<
  typeof workspaceInboxListResponseSchema
>;
export type WorkspaceInboxSummaryResponse = z.infer<
  typeof workspaceInboxSummaryResponseSchema
>;
export type WorkspaceInboxReadResponse = z.infer<
  typeof workspaceInboxReadResponseSchema
>;
