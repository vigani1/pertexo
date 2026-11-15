import { responseSchema } from '../shared/response-schema.js';
import {
  ianaTimeZoneSchema,
  noticeEmailModeSchema,
  noticeScheduleSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
import { STORED_INTEGER_MAX } from '@pertexo/workflow-model';

const PREFERENCES_BOUNDS = Object.freeze({
  hourMaximum: 23,
  emailUnavailableReasonCharacters: 300,
});

/** What a one-click unsubscribe carries: its URL token, its header key and the form mail clients post. */
export const NOTICE_UNSUBSCRIBE_LIMITS = Object.freeze({
  tokenCharacters: 4_096,
  keyCharacters: 4_096,
  formBytes: 8_192,
});
// The next revision must still fit a stored integer.
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(STORED_INTEGER_MAX - 1);
export const noticePreferencesRequestSchema = noticeScheduleSchema
  .extend({
    mode: noticeEmailModeSchema.nullable(),
    expectedRevision: revision,
  })
  .strict();
export const noticeDefaultsRequestSchema = noticeScheduleSchema
  .extend({ expectedRevision: revision })
  .strict();
export const noticePreferencesResponseSchema = responseSchema(
  z
    .object({
      revision,
      mode: noticeEmailModeSchema.nullable(),
      hour: z.number().int().min(0).max(PREFERENCES_BOUNDS.hourMaximum),
      timeZone: ianaTimeZoneSchema,
      defaults: noticeScheduleSchema.extend({ revision }).strict(),
      effective: noticeScheduleSchema,
      canManageDefaults: z.boolean(),
      emailAvailable: z.boolean(),
      emailUnavailableReason: z
        .string()
        .max(PREFERENCES_BOUNDS.emailUnavailableReasonCharacters)
        .nullable(),
    })
    .strict(),
);
export const noticeSubjectParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    subjectKind: z.enum(['workflow', 'connection']),
    subjectId: z.uuid(),
  })
  .strict();
export const noticeSubscriptionSchema = responseSchema(
  z.object({ revision, followed: z.boolean(), muted: z.boolean() }).strict(),
);
export const noticeSubscriptionRequestSchema = noticeSubscriptionSchema
  .omit({ revision: true })
  .extend({ expectedRevision: revision })
  .strict();
export const noticeCommandResponseSchema = responseSchema(
  z.object({ revision, changed: z.boolean(), replayed: z.boolean() }).strict(),
);
export const noticeOneClickQuerySchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(NOTICE_UNSUBSCRIBE_LIMITS.tokenCharacters)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();
export const noticeUnsubscribeResponseSchema = responseSchema(
  z.object({ unsubscribed: z.literal(true) }).strict(),
);
export type NoticeEmailMode = z.output<typeof noticeEmailModeSchema>;
export type { NoticeSchedule } from '@pertexo/workflow-model';
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
