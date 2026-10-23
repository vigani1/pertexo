import type {
  NodeConnectionRuntime,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { vi } from 'vitest';
import { SLACK_BOT_TOKEN_CONNECTION_SLOT } from '../../src/index.js';
import type { SlackApiResult, SlackClient } from '../../src/server.js';

export const connectionId = '22222222-2222-4222-8222-222222222222';
export const secretVersionId = '33333333-3333-4333-8333-333333333333';
export function runtime(clientResult: SlackApiResult | Error | undefined) {
  const secret = new TextEncoder().encode(
    JSON.stringify({
      type: 'slack_bot_token',
      botToken: 'xoxb-123456789-secret',
    }),
  );
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const assertCurrent = vi.fn<
    NonNullable<NodeConnectionRuntime['assertCurrent']>
  >(() => Promise.resolve());
  const value: NodeExecutionRuntime = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '44444444-4444-4444-8444-444444444444',
    nodeRunId: '55555555-5555-4555-8555-555555555555',
    attemptId: '66666666-6666-4666-8666-666666666666',
    attemptNumber: 1,
    nodeId: 'slack-node',
    invocationKey: 'slack-node',
    sideEffectClass: 'unsafe',
    beforeDispatch,
    observeConnectionHealth: vi.fn(),
    connections: {
      assertCurrent,
      resolve: () =>
        Promise.resolve({
          connectionId,
          providerKey: 'slack',
          authType: 'slack_bot_token',
          secretVersionId,
          secret,
        }),
    },
  };
  const sendMessage = vi.fn<SlackClient['sendMessage']>(
    async (input: { beforeDispatch(): Promise<void> }) => {
      await input.beforeDispatch();
      if (clientResult instanceof Error) throw clientResult;
      if (clientResult === undefined)
        throw new Error('Slack test result was not provided');
      return clientResult;
    },
  );
  return { assertCurrent, beforeDispatch, secret, sendMessage, value };
}
export function invocation(value: NodeExecutionRuntime) {
  return {
    config: { timeoutMillis: 10_000 },
    input: { channelId: 'C123ABC', text: 'deployment complete' },
    connectionRefs: { [SLACK_BOT_TOKEN_CONNECTION_SLOT]: connectionId },
    signal: new AbortController().signal,
    runtime: value,
  };
}
