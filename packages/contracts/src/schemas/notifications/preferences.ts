import { z } from 'zod';
import { ianaTimeZoneSchema } from '@pertexo/workflow-model';
const revision = z.number().int().nonnegative().max(2_147_483_646);
const noticeEmailModeSchema = z.enum(['off', 'immediate', 'hourly', 'daily']);
const noticeScheduleSchema = z
  .object({
    mode: noticeEmailModeSchema,
    hour: z.number().int().min(0).max(23),
    timeZone: ianaTimeZoneSchema,
  })
  .strict();
export const noticePreferencesRequestSchema = noticeScheduleSchema
  .extend({
    mode: noticeEmailModeSchema.nullable(),
    expectedRevision: revision,
  })
  .strict();
export const noticeDefaultsRequestSchema = noticeScheduleSchema
  .extend({ expectedRevision: revision })
  .strict();
export const noticePreferencesResponseSchema = z
  .object({
    revision,
    mode: noticeEmailModeSchema.nullable(),
    hour: z.number().int().min(0).max(23),
    timeZone: ianaTimeZoneSchema,
    defaults: noticeScheduleSchema.extend({ revision }).strict(),
    effective: noticeScheduleSchema,
    canManageDefaults: z.boolean(),
    emailAvailable: z.boolean(),
    emailUnavailableReason: z.string().max(300).nullable(),
  })
  .strict();
export const noticeSubjectParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    subjectKind: z.enum(['workflow', 'connection']),
    subjectId: z.uuid(),
  })
  .strict();
export const noticeSubscriptionSchema = z
  .object({ revision, followed: z.boolean(), muted: z.boolean() })
  .strict();
export const noticeSubscriptionRequestSchema = noticeSubscriptionSchema
  .omit({ revision: true })
  .extend({ expectedRevision: revision })
  .strict();
export const noticeCommandResponseSchema = z
  .object({ revision, changed: z.boolean(), replayed: z.boolean() })
  .strict();
export const noticeUnsubscribeResponseSchema = z
  .object({ unsubscribed: z.literal(true) })
  .strict();
export type NoticeEmailMode = z.output<typeof noticeEmailModeSchema>;
export type NoticeSchedule = z.output<typeof noticeScheduleSchema>;
export type NoticePreferencesRequest = z.output<
  typeof noticePreferencesRequestSchema
>;
export type NoticeDefaultsRequest = z.output<
  typeof noticeDefaultsRequestSchema
>;
export type NoticePreferencesResponse = z.output<
  typeof noticePreferencesResponseSchema
>;
export type NoticeSubscription = z.output<typeof noticeSubscriptionSchema>;
export type NoticeSubscriptionRequest = z.output<
  typeof noticeSubscriptionRequestSchema
>;
export type NoticeCommandResponse = z.output<
  typeof noticeCommandResponseSchema
>;
export type NoticeSubjectParams = z.output<typeof noticeSubjectParamsSchema>;
