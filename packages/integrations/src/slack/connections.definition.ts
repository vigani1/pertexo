import {
  CONNECTION_CREDENTIALS_BOUNDS,
  slackBotTokenCredentialSchema,
} from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';

const slackFields = {
  botToken: slackBotTokenCredentialSchema.unwrap().shape.botToken.meta({
    title: 'Slack bot token',
    help: 'slack',
    trim: true,
    placeholder: 'xoxb-…',
    secret: true,
    inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.botTokenCharacters,
    description: 'Stored encrypted. Nobody, including you, can see it again.',
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
    kind: 'slack',
    method: 'POST',
    target: 'https://slack.com/api/auth.test',
  },
  slot: { key: 'slack_bot_token', primary: true },
} as const satisfies ConnectionDefinition;
