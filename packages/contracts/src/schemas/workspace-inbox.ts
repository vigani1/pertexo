import { z } from 'zod';

import { workflowRunFailedStepSchema } from './workflow-runs.js';

/** ADR 055: one notice per failing workflow, never run inputs or errors. */
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
export const workspaceInboxThreadParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid() })
  .strict();
export const workspaceInboxThreadSchema = z
  .object({
    workflowId: z.uuid(),
    workflowName: z.string().min(1).max(200),
    kind: workspaceInboxFailureKindSchema,
    occurrenceCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    firstOccurredAt: workspaceInboxTimestampSchema,
    latestOccurredAt: workspaceInboxTimestampSchema,
    latestRunId: z.uuid(),
    latestFailedStep: workflowRunFailedStepSchema.nullable(),
    revision: workspaceInboxRevisionSchema,
    unread: z.boolean(),
  })
  .strict();
export const workspaceInboxListResponseSchema = z
  .object({
    items: z.array(workspaceInboxThreadSchema).max(100),
    nextCursor: workspaceInboxCursorSchema.nullable(),
    /** The newest revision visible to the reader; the read-all cut. */
    revision: workspaceInboxRevisionSchema,
  })
  .strict();
export const workspaceInboxSummaryResponseSchema = z
  .object({
    unreadCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    revision: workspaceInboxRevisionSchema,
  })
  .strict();
/** The revision the reader saw; the server never records more than exists. */
export const workspaceInboxReadRequestSchema = z
  .object({ revision: workspaceInboxRevisionSchema })
  .strict();
export const workspaceInboxReadResponseSchema = z
  .object({
    workflowId: z.uuid(),
    unread: z.boolean(),
    revision: workspaceInboxRevisionSchema,
  })
  .strict();
/** Threads at or below the revision the reader saw become read. */
export const workspaceInboxReadAllRequestSchema = z
  .object({ revision: workspaceInboxRevisionSchema })
  .strict();
export const workspaceInboxReadAllResponseSchema = z
  .object({ marked: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
  .strict();
/** Stream events carry no notice content; clients refetch on each one. */
export const workspaceInboxStreamEventNameSchema = z.enum([
  'inbox.ready',
  'inbox.changed',
]);
export const workspaceInboxStreamEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Newest known revision, or null when hints may have been missed. */
    revision: workspaceInboxRevisionSchema.nullable(),
  })
  .strict();

export type WorkspaceInboxFilter = z.infer<typeof workspaceInboxFilterSchema>;
export type WorkspaceInboxThread = z.infer<typeof workspaceInboxThreadSchema>;
export type WorkspaceInboxListQuery = z.infer<
  typeof workspaceInboxListQuerySchema
>;
export type WorkspaceInboxListResponse = z.infer<
  typeof workspaceInboxListResponseSchema
>;
export type WorkspaceInboxSummaryResponse = z.infer<
  typeof workspaceInboxSummaryResponseSchema
>;
export type WorkspaceInboxReadRequest = z.infer<
  typeof workspaceInboxReadRequestSchema
>;
export type WorkspaceInboxReadResponse = z.infer<
  typeof workspaceInboxReadResponseSchema
>;
export type WorkspaceInboxReadAllRequest = z.infer<
  typeof workspaceInboxReadAllRequestSchema
>;
export type WorkspaceInboxReadAllResponse = z.infer<
  typeof workspaceInboxReadAllResponseSchema
>;
export type WorkspaceInboxStreamEventName = z.infer<
  typeof workspaceInboxStreamEventNameSchema
>;
export type WorkspaceInboxStreamEvent = z.infer<
  typeof workspaceInboxStreamEventSchema
>;
