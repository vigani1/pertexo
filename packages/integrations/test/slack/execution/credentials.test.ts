import { ProviderExecutionRateLimitError } from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import { createSlackSendMessageExecutorRegistration } from '../../../src/server.js';
import { providerCredentialFailureCases } from '../../support/provider-credential-failure-cases.js';
import {
  connectionId,
  secretVersionId,
  runtime,
  invocation,
} from '../../support/slack-execution.js';
describe('slack.send_message@1', () => {
  it('exposes an ordinary Slack resolution throttle without provider dispatch', async () => {
    const limited = runtime(undefined);
    limited.value = Object.freeze({
      ...limited.value,
      connections: {
        assertCurrent: limited.assertCurrent,
        resolve: () => Promise.reject(new ProviderExecutionRateLimitError(7)),
      },
    });
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: limited.sendMessage },
      }).execute(invocation(limited.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'rate_limit',
      minimumRetryDelayMillis: 7_000,
      possiblyDispatched: false,
    });
    expect(limited.sendMessage).not.toHaveBeenCalled();
  });
  it('keeps a throttle with unreadable retry metadata a provider retry without dispatch or health evidence', async () => {
    const limited = runtime(undefined);
    const error = new ProviderExecutionRateLimitError(7);
    Object.defineProperty(error, 'retryAfterSeconds', {
      get: () => {
        throw new Error('unreadable provider metadata');
      },
    });
    limited.value = Object.freeze({
      ...limited.value,
      connections: {
        assertCurrent: limited.assertCurrent,
        resolve: () => Promise.reject(error),
      },
    });
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: limited.sendMessage },
      }).execute(invocation(limited.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'provider',
      possiblyDispatched: false,
    });
    expect(limited.sendMessage).not.toHaveBeenCalled();
    expect(limited.beforeDispatch).not.toHaveBeenCalled();
    expect(limited.value.observeConnectionHealth).not.toHaveBeenCalled();
  });
  it('rejects a mismatched resolved Slack credential before provider dispatch', async () => {
    const mismatched = runtime(undefined);
    mismatched.value = Object.freeze({
      ...mismatched.value,
      connections: {
        assertCurrent: mismatched.assertCurrent,
        resolve: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'email',
            authType: 'slack_bot_token',
            secretVersionId,
            secret: mismatched.secret,
          }),
      },
    });
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: mismatched.sendMessage },
      }).execute(invocation(mismatched.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(mismatched.sendMessage).not.toHaveBeenCalled();
  });
  it.each(providerCredentialFailureCases)(
    'preserves %s without sending provider bytes',
    async (_name, stage, error, kind, errorKind) => {
      const state = runtime({
        kind: 'succeeded',
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      });
      const originalConnections = state.value.connections;
      if (originalConnections === undefined)
        throw new Error('Expected connection runtime');
      state.value = Object.freeze({
        ...state.value,
        connections: {
          assertCurrent:
            stage === 'fence'
              ? () => Promise.reject(error)
              : state.assertCurrent,
          resolve:
            stage === 'resolve'
              ? () => Promise.reject(error)
              : originalConnections.resolve.bind(originalConnections),
        },
      });

      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({ kind, errorKind, possiblyDispatched: false });
      expect(state.beforeDispatch).not.toHaveBeenCalled();
      expect(state.value.observeConnectionHealth).not.toHaveBeenCalled();
    },
  );
  it.each(['resolve', 'fence'] as const)(
    'preserves an earlier uncertain dispatch across a transient %s outage',
    async (stage) => {
      const state = runtime({
        kind: 'succeeded',
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      });
      const connections = state.value.connections;
      if (connections === undefined) throw new Error('connections missing');
      state.value = Object.freeze({
        ...state.value,
        providerDispatchUnresolved: true,
        connections: {
          assertCurrent:
            stage === 'fence'
              ? () => Promise.reject(new Error('postgres unavailable'))
              : state.assertCurrent,
          resolve:
            stage === 'resolve'
              ? () => Promise.reject(new Error('postgres unavailable'))
              : connections.resolve.bind(connections),
        },
      });

      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      });
    },
  );
});
