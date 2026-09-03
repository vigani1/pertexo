import { z } from 'zod';

const MAX_TEXT_BYTES = 16_384;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const slackSendMessageConfigSchema = z
  .object({ timeoutMillis: z.number().int().min(1).max(30_000) })
  .strict()
  .readonly();

export const slackChannelIdSchema = z
  .string()
  .min(2)
  .max(255)
  .regex(/^[CDGU][A-Z0-9]+$/u);

export const slackMessageTextSchema = z
  .string()
  .min(1)
  .max(4_000)
  .refine((value) => utf8Bytes(value) <= MAX_TEXT_BYTES);

export const slackSendMessageInputSchema = z
  .object({ channelId: slackChannelIdSchema, text: slackMessageTextSchema })
  .strict()
  .readonly();

export const slackMessageTimestampSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^\d{1,20}\.\d{1,10}$/u);

export const slackSendMessageOutputSchema = z
  .object({
    channelId: slackChannelIdSchema,
    messageTs: slackMessageTimestampSchema,
  })
  .strict()
  .readonly();

export const resolvedSlackBotTokenCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('slack_bot_token'),
    botToken: z
      .string()
      .min(10)
      .max(512)
      .regex(/^xoxb-[A-Za-z0-9-]+$/u),
  })
  .strict()
  .readonly();

export type SlackSendMessageOutput = z.output<
  typeof slackSendMessageOutputSchema
>;

export const SLACK_SEND_MESSAGE_LIMITS = Object.freeze({
  maxResponseBytes: 65_536,
  maxRetryAfterMillis: 300_000,
  maxTextBytes: MAX_TEXT_BYTES,
});
