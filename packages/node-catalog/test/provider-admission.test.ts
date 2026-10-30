import { describe, expect, it, vi } from 'vitest';
import {
  EMAIL_SEND_NOTIFICATION_DEFINITION,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_EXECUTOR,
  SLACK_SEND_MESSAGE_DEFINITION,
  SLACK_SEND_MESSAGE_EXECUTOR,
} from '@pertexo/integrations';

import { createPlatformNodeRegistry } from '../src/server.js';

// The platform registry validates a provider step's config and input once,
// before its executor runs, so no provider is ever called with either.
function registry() {
  const clients = {
    sendNotification: vi.fn(),
    sendMessage: vi.fn(),
    executeStreaming: vi.fn(),
  };
  return {
    clients,
    registry: createPlatformNodeRegistry({
      emailSendNotification: {
        client: { sendNotification: clients.sendNotification },
      },
      slackSendMessage: { client: { sendMessage: clients.sendMessage } },
      httpRequest: {
        httpClient: { executeStreaming: clients.executeStreaming } as never,
      },
    }),
  };
}

describe('provider steps admitted by the platform registry', () => {
  const email = {
    definition: EMAIL_SEND_NOTIFICATION_DEFINITION,
    executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
  };
  const slack = {
    definition: SLACK_SEND_MESSAGE_DEFINITION,
    executor: SLACK_SEND_MESSAGE_EXECUTOR,
  };
  const http = {
    definition: HTTP_REQUEST_DEFINITION,
    executor: HTTP_REQUEST_EXECUTOR,
  };
  it.each([
    {
      name: 'email config',
      step: email,
      config: { timeoutMillis: 0 },
      input: { toEmail: 'to@example.com', subject: 'Subject', text: 'Text' },
      code: 'invalid_config',
    },
    {
      name: 'email input',
      step: email,
      config: { timeoutMillis: 10_000 },
      input: { toEmail: 'not an address', subject: 'Subject', text: 'Text' },
      code: 'invalid_input',
    },
    {
      name: 'Slack config',
      step: slack,
      config: { timeoutMillis: 0 },
      input: { channelId: 'C123ABC', text: 'Text' },
      code: 'invalid_config',
    },
    {
      name: 'Slack input',
      step: slack,
      config: { timeoutMillis: 10_000 },
      input: { channelId: 'not-a-channel', text: 'Text' },
      code: 'invalid_input',
    },
    {
      name: 'HTTP config',
      step: http,
      config: { method: 'TRACE' },
      input: {},
      code: 'invalid_config',
    },
  ])(
    'refuses invalid $name before any provider call',
    async ({ step, config, input, code }) => {
      const { clients, registry: platform } = registry();
      await expect(
        platform.execute({
          ...step,
          config,
          input,
          connectionRefs: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code });
      expect(clients.sendNotification).not.toHaveBeenCalled();
      expect(clients.sendMessage).not.toHaveBeenCalled();
      expect(clients.executeStreaming).not.toHaveBeenCalled();
    },
  );
});
