import { SLACK_BOT_TOKEN_CONNECTION } from './connections.definition.js';
import { createSlackSendMessageExecutorRegistration } from './send-message/send-message.executor.js';
import type { IntegrationModule } from '../providers/integration-module.js';
import {
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_POLICY,
} from './send-message/send-message.definition.js';

export const SLACK_MODULE = {
  key: 'slack',
  presentation: { name: 'Slack', icon: 'hash', group: 'action' },
  connections: [SLACK_BOT_TOKEN_CONNECTION],
  steps: [
    {
      registration: SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
      createExecutor: ({ slackSendMessage, slackSendMessageTelemetry }) =>
        createSlackSendMessageExecutorRegistration({
          ...slackSendMessage,
          ...(slackSendMessageTelemetry === undefined
            ? {}
            : { telemetry: slackSendMessageTelemetry }),
        }),
    },
  ],
  policies: [SLACK_SEND_MESSAGE_POLICY],
} satisfies IntegrationModule;
