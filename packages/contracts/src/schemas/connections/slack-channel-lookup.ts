import { z } from 'zod';

export const SLACK_CHANNELS_LOOKUP = 'channels';

/** ADR 046: at most this many channel names resolve in one lookup. */
export const SLACK_CHANNEL_LOOKUP_LIMIT = 10;
export const slackChannelLookupIdSchema = z
  .string()
  .regex(/^[CDGU][A-Z0-9]{1,79}$/u);
export const slackChannelLookupInputSchema = z.strictObject({
  channelIds: z
    .array(slackChannelLookupIdSchema)
    .min(1)
    .max(SLACK_CHANNEL_LOOKUP_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Channel IDs must be unique',
    }),
});
export const slackChannelUnresolvedReasonSchema = z.enum([
  'missing_scope',
  'not_found',
  'connection_unavailable',
  'rate_limited',
  'provider_unavailable',
  'not_a_channel',
]);
export type SlackChannelUnresolvedReason = z.output<
  typeof slackChannelUnresolvedReasonSchema
>;
