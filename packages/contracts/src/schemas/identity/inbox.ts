import { z } from 'zod';
import { taskDetailsSchema } from '@pertexo/workflow-model';

import { workflowRunFailedStepSchema } from '../execution/runs.js';

/** ADR 055: one notice per failing workflow, never run inputs or errors. */
const workspaceInboxFailureKindSchema = z.enum([
  'failed',
  'timed_out',
  'outcome_unknown',
]);
const workspaceInboxTimestampSchema = z.iso.datetime({ precision: 6 });
/** PostgreSQL bigint revisions stay decimal strings across the wire. */
const workspaceInboxRevisionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/u)
  .refine(
    (value) => {
      try {
        return BigInt(value) <= 9223372036854775807n;
      } catch {
        return false;
      }
    },
    { message: 'Revision exceeds PostgreSQL bigint' },
  );
export const workspaceInboxCursorSchema = z.string().min(1).max(1_024);
export const workspaceCapacityLimitSchema = z.enum([
  'active',
  'queue',
  'artifact_bytes',
  'artifact_count',
]);
export type WorkspaceCapacityLimit = z.output<
  typeof workspaceCapacityLimitSchema
>;
export const workspaceNoticeKindSchema = z.enum([
  'workflow_failure',
  'workflow_auto_paused',
  'connection_attention',
  'failure_alert_attention',
  'limit_reached',
  'limit_approaching',
  'approval_waiting',
  'publication_review_waiting',
  'workflow_mention',
]);
export const workspaceInboxFilterSchema = z.enum(['all', 'unread']);
export const workspaceInboxLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100);
export const workspaceInboxListQuerySchema = z
  .object({
    filter: workspaceInboxFilterSchema.optional(),
    noticeKind: workspaceNoticeKindSchema.optional(),
    limit: workspaceInboxLimitSchema.optional(),
    after: workspaceInboxCursorSchema.optional(),
  })
  .strict();
export const workspaceInboxThreadParamsSchema = z
  .object({ workspaceId: z.uuid(), threadId: z.uuid() })
  .strict();
export const workspaceInboxFailureThreadSchema = z
  .object({
    id: z.uuid(),
    noticeKind: z.literal('workflow_failure'),
    workflowId: z.uuid(),
    workflowName: z.string().min(1).max(200),
    kind: workspaceInboxFailureKindSchema,
    failureDays: z
      .array(
        z
          .object({
            day: z.iso.date(),
            count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(30),
    occurrenceCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    firstOccurredAt: workspaceInboxTimestampSchema,
    latestOccurredAt: workspaceInboxTimestampSchema,
    latestRunId: z.uuid(),
    latestFailedStep: workflowRunFailedStepSchema.nullable(),
    revision: workspaceInboxRevisionSchema,
    unread: z.boolean(),
  })
  .strict();
const operationalAttentionSchema = z
  .object({
    id: z.uuid(),
    noticeKind: z.enum([
      'workflow_auto_paused',
      'connection_attention',
      'failure_alert_attention',
      'limit_reached',
      'limit_approaching',
      'approval_waiting',
      'publication_review_waiting',
    ]),
    subjectId: z.uuid(),
    workflowId: z.uuid().nullable(),
    name: z.string().max(200),
    details: taskDetailsSchema.default({}),
    occurrenceCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    firstOccurredAt: workspaceInboxTimestampSchema,
    latestOccurredAt: workspaceInboxTimestampSchema,
    revision: workspaceInboxRevisionSchema,
    unread: z.boolean(),
    limits: z.array(workspaceCapacityLimitSchema).max(4),
  })
  .strict();
const mentionAttentionSchema = operationalAttentionSchema
  .extend({
    noticeKind: z.literal('workflow_mention'),
    workflowId: z.uuid(),
    threadId: z.uuid(),
    commentId: z.uuid(),
    details: z.object({}).strict().default({}),
    limits: z.tuple([]),
  })
  .strict();
export const workspaceInboxAttentionThreadSchema = z.union([
  operationalAttentionSchema,
  mentionAttentionSchema,
]);
export const workspaceInboxThreadSchema = z.union([
  workspaceInboxFailureThreadSchema,
  workspaceInboxAttentionThreadSchema,
]);
export type WorkspaceInboxFailureThread = z.output<
  typeof workspaceInboxFailureThreadSchema
>;
export type WorkspaceInboxAttentionThread = z.output<
  typeof workspaceInboxAttentionThreadSchema
>;
export type WorkspaceNoticeKind = z.output<typeof workspaceNoticeKindSchema>;
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
    threadId: z.uuid(),
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
    /** Newest known revision, or null when hints may have been missed. */
    revision: workspaceInboxRevisionSchema.nullable(),
  })
  .strict();

export type WorkspaceInboxFilter = z.infer<typeof workspaceInboxFilterSchema>;
export type WorkspaceInboxThread = z.infer<typeof workspaceInboxThreadSchema>;
export type WorkspaceInboxListResponse = z.infer<
  typeof workspaceInboxListResponseSchema
>;
export type WorkspaceInboxSummaryResponse = z.infer<
  typeof workspaceInboxSummaryResponseSchema
>;
export type WorkspaceInboxReadResponse = z.infer<
  typeof workspaceInboxReadResponseSchema
>;
export type WorkspaceInboxReadAllResponse = z.infer<
  typeof workspaceInboxReadAllResponseSchema
>;
export type WorkspaceInboxStreamEventName = z.infer<
  typeof workspaceInboxStreamEventNameSchema
>;
