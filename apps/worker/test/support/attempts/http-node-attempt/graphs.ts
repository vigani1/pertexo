import {
  connectionId,
  slackConnectionId,
  emailConnectionId,
  slackMessageText,
  emailRecipient,
  emailSubject,
  emailText,
} from './environment.js';

export function graph() {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'http',
        definition: { key: 'http.request', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://provider.example.test/resource',
          headers: { accept: 'application/json' },
          timeoutMillis: 5_000,
          maxRedirects: 0,
          maxResponseBytes: 100_000,
          inlineResponseBytes: 1_024,
        },
        inputMappings: {},
        connectionRefs: { http_headers: connectionId },
      },
      {
        id: 'slack',
        definition: { key: 'slack.send_message', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          channelId: { kind: 'literal' as const, value: 'C123ABC' },
          text: { kind: 'literal' as const, value: slackMessageText },
        },
        connectionRefs: { slack_bot_token: slackConnectionId },
      },
      {
        id: 'email',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 30, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: emailRecipient },
          subject: { kind: 'literal' as const, value: emailSubject },
          text: { kind: 'literal' as const, value: emailText },
        },
        connectionRefs: { resend_api_key: emailConnectionId },
      },
      {
        id: 'email-rotated',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 40, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: emailRecipient },
          subject: { kind: 'literal' as const, value: emailSubject },
          text: { kind: 'literal' as const, value: emailText },
        },
        connectionRefs: { resend_api_key: emailConnectionId },
      },
    ],
    edges: [
      {
        id: 'manual-http',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'http', port: 'in' },
      },
      {
        id: 'http-slack',
        source: { nodeId: 'http', port: 'out' },
        target: { nodeId: 'slack', port: 'in' },
      },
      {
        id: 'slack-email',
        source: { nodeId: 'slack', port: 'out' },
        target: { nodeId: 'email', port: 'in' },
      },
      {
        id: 'email-rotated',
        source: { nodeId: 'email', port: 'out' },
        target: { nodeId: 'email-rotated', port: 'in' },
      },
    ],
  };
}

export type ProviderScenario = 'email' | 'http' | 'http_post' | 'slack';

function providerScenarioNode(provider: ProviderScenario) {
  switch (provider) {
    case 'http':
    case 'http_post':
      return {
        id: 'provider',
        definition: { key: 'http.request', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          method: provider === 'http' ? 'GET' : 'POST',
          url: 'https://provider.example.test/scenario',
          headers: { accept: 'application/json' },
          timeoutMillis: 5_000,
          maxRedirects: 0,
          maxResponseBytes: 100_000,
          inlineResponseBytes: 100_000,
        },
        inputMappings: {},
        connectionRefs: { http_headers: connectionId },
      };
    case 'slack':
      return {
        id: 'provider',
        definition: { key: 'slack.send_message', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          channelId: { kind: 'literal' as const, value: 'C123ABC' },
          text: { kind: 'literal' as const, value: slackMessageText },
        },
        connectionRefs: { slack_bot_token: slackConnectionId },
      };
    case 'email':
      return {
        id: 'provider',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 5_000 },
        inputMappings: {
          toEmail: { kind: 'literal' as const, value: emailRecipient },
          subject: { kind: 'literal' as const, value: emailSubject },
          text: { kind: 'literal' as const, value: emailText },
        },
        connectionRefs: { resend_api_key: emailConnectionId },
      };
  }
}

export function providerScenarioGraph(provider: ProviderScenario) {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      providerScenarioNode(provider),
    ],
    edges: [
      {
        id: 'manual-provider',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'provider', port: 'in' },
      },
    ],
  };
}
