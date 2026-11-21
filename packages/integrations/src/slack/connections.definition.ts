import {
  CONNECTION_CREDENTIALS_BOUNDS,
  slackBotTokenCredentialSchema,
} from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';

import { SLACK_REJECTIONS } from './rejection-policy.js';
import {
  slackChannelIdSchema,
  slackMessageTimestampSchema,
} from './send-message/send-message.schemas.js';

const SLACK_ERROR_CHARACTERS = 128;
export const slackErrorSchema = z
  .string()
  .min(1)
  .max(SLACK_ERROR_CHARACTERS)
  .regex(/^[a-z0-9_]+$/u);
export const slackResponseSchema = z
  .object({
    ok: z.boolean(),
    channel: slackChannelIdSchema.optional(),
    ts: slackMessageTimestampSchema.optional(),
    error: slackErrorSchema.optional(),
  })
  .strip();
const slackFields = {
  botToken: slackBotTokenCredentialSchema.unwrap().shape.botToken.meta({
    title: 'Slack bot token',
    help: 'slack',
    trim: true,
    placeholder: 'xoxb-…',
    secret: true,
    inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.botTokenCharacters,
  }),
};

export const SLACK_BOT_TOKEN_CONNECTION = {
  authType: 'slack_bot_token',
  presentation: {
    requirement: 'Slack connection',
    choice: 'slack',
    pickerOrder: 1,
    name: 'Slack',
    purpose: 'Post messages to channels',
    credential: 'bot token',
    savedCredential: 'bot token',
    usedBy: 'Send Slack message steps and Slack alerts',
    nameSuffix: 'Slack',
  },
  schema: slackBotTokenCredentialSchema
    .unwrap()
    .safeExtend(slackFields)
    .readonly(),
  fields: z.strictObject(slackFields),
  auth: { kind: 'bearer', field: 'botToken' },
  test: {
    kind: 'http',
    formTest: 'slack',
    method: 'POST',
    target: 'https://slack.com/api/auth.test',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
    },
    credentialRejection: false,
    success: {
      status: '2xx',
      reportStatus: 200,
      json: {
        schema: slackResponseSchema,
        equals: { pointer: '/ok', value: true },
        rejection: {
          pointer: '/error',
          rateLimited: 'ratelimited',
          reauthorization: Object.fromEntries(
            Object.entries(SLACK_REJECTIONS).flatMap(([code, policy]) =>
              'health' in policy ? [[code, policy.health.reasonCode]] : [],
            ),
          ),
        },
      },
    },
  },
  slot: { key: 'slack_bot_token', primary: true },
} as const satisfies ConnectionDefinition;
