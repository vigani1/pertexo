import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';

import {
  slackSendMessageConfigSchema,
  slackSendMessageInputSchema,
  slackSendMessageOutputSchema,
} from './validation.js';

export const SLACK_SEND_MESSAGE_DEFINITION = Object.freeze({
  key: 'slack.send_message',
  version: 1,
});
export const SLACK_SEND_MESSAGE_EXECUTOR = Object.freeze({
  key: 'slack.send_message',
  version: 1,
});
export const SLACK_BOT_TOKEN_CONNECTION_SLOT = 'slack_bot_token' as const;
export const SLACK_SEND_MESSAGE_POLICY = Object.freeze({
  key: 'slack.send_message',
  version: 1,
});

export const SLACK_SEND_MESSAGE_MANIFEST: NodeManifest = Object.freeze({
  schemaVersion: 1,
  definition: SLACK_SEND_MESSAGE_DEFINITION,
  family: 'action',
  configVersion: 1,
  configSchema: generateSchemaDocument(slackSendMessageConfigSchema),
  inputSchema: generateSchemaDocument(slackSendMessageInputSchema),
  outputSchema: generateSchemaDocument(slackSendMessageOutputSchema),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([SLACK_BOT_TOKEN_CONNECTION_SLOT]),
  connectionRequirements: Object.freeze([SLACK_BOT_TOKEN_CONNECTION_SLOT]),
  integration: Object.freeze({
    providerKey: 'slack',
    operationKey: 'send_message',
  }),
  retryClass: 'unsafe',
  resourceClass: 'io',
  capabilities: Object.freeze(['external_http', 'side_effect_disclosure']),
  lifecycle: 'active',
  executor: SLACK_SEND_MESSAGE_EXECUTOR,
  executorAbi: 2,
  policyReferences: Object.freeze([SLACK_SEND_MESSAGE_POLICY]),
});

export const SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION = Object.freeze({
  manifest: SLACK_SEND_MESSAGE_MANIFEST,
  configSchema: slackSendMessageConfigSchema,
  inputSchema: slackSendMessageInputSchema,
  outputSchema: slackSendMessageOutputSchema,
});
