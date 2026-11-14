import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';

/** ADR 046: at most this many channel names resolve in one lookup. */
export const SLACK_CHANNEL_LOOKUP_LIMIT = 10;
const slackChannelIdPattern = '[CDGU][A-Z0-9]{1,79}';
export const slackChannelLookupIdSchema = z
  .string()
  .regex(new RegExp(`^${slackChannelIdPattern}$`, 'u'));
const slackChannelLookupChannelIdsSchema = z
  .string()
  .regex(
    new RegExp(
      `^${slackChannelIdPattern}(?:,${slackChannelIdPattern}){0,${String(SLACK_CHANNEL_LOOKUP_LIMIT - 1)}}$`,
      'u',
    ),
  )
  .transform((value) => value.split(','))
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Channel IDs must be unique',
  });
export const slackChannelLookupQuerySchema = z
  .object({ channelIds: slackChannelLookupChannelIdsSchema })
  .strict();
export const slackChannelUnresolvedReasonSchema = z.enum([
  'missing_scope',
  'not_found',
  'connection_unavailable',
  'rate_limited',
  'provider_unavailable',
  'not_a_channel',
]);
export const slackChannelLookupItemSchema = z.discriminatedUnion('status', [
  z
    .object({
      channelId: slackChannelLookupIdSchema,
      status: z.literal('resolved'),
      name: z.string().min(1).max(80),
    })
    .strict()
    .readonly(),
  z
    .object({
      channelId: slackChannelLookupIdSchema,
      status: z.literal('unresolved'),
      reason: slackChannelUnresolvedReasonSchema,
    })
    .strict()
    .readonly(),
]);
export const slackChannelLookupResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(slackChannelLookupItemSchema)
        .max(SLACK_CHANNEL_LOOKUP_LIMIT),
    })
    .strict()
    .readonly(),
);
export type SlackChannelUnresolvedReason = z.output<
  typeof slackChannelUnresolvedReasonSchema
>;
export type SlackChannelLookupItem = z.output<
  typeof slackChannelLookupItemSchema
>;
export type SlackChannelLookupResponse = z.output<
  typeof slackChannelLookupResponseSchema
>;
