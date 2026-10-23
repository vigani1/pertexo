import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';
import {
  SLACK_SEND_MESSAGE_MANIFEST,
  slackSendMessageInputSchema,
} from '../../../src/index.js';
import { createSlackSendMessageExecutorRegistration } from '../../../src/server.js';

import {
  connectionId,
  secretVersionId,
  runtime,
  invocation,
} from '../../support/slack-execution.js';
describe('slack.send_message@1', () => {
  it.each([
    [
      'account_inactive',
      'connection.slack_account_inactive',
      'failed',
      'authentication',
      false,
    ],
    [
      'token_revoked',
      'connection.slack_token_revoked',
      'failed',
      'authentication',
      false,
    ],
    [
      'token_expired',
      'connection.slack_token_expired',
      'outcome_unknown',
      'provider',
      true,
    ],
  ] as const)(
    'captures %s without changing the provider outcome',
    async (error, reasonCode, kind, errorKind, possiblyDispatched) => {
      const state = runtime({ kind: 'rejected', error });
      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({ kind, errorKind, possiblyDispatched });
      expect(
        state.value.observeConnectionHealth,
      ).toHaveBeenCalledExactlyOnceWith({
        kind: 'reauthorization_required',
        reasonCode,
      });
      expect(state.secret.every((byte) => byte === 0)).toBe(true);
    },
  );
  it.each([
    { kind: 'rejected', error: 'invalid_auth' },
    { kind: 'rejected', error: 'not_authed' },
    { kind: 'rejected', error: 'missing_scope' },
    { kind: 'http_failure', status: 401 },
    { kind: 'http_failure', status: 403 },
    { kind: 'rate_limited', retryAfterMillis: 1_000 },
    { kind: 'invalid_response' },
    { kind: 'succeeded', channelId: 'COTHER', messageTs: '1724412345.000100' },
    { kind: 'succeeded', channelId: 'C123ABC', messageTs: 'malformed' },
    new Error('transport failed'),
  ] as const)(
    'does not capture ambiguous or invalid result %#',
    async (result) => {
      const state = runtime(result);
      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toThrow();
      expect(state.value.observeConnectionHealth).not.toHaveBeenCalled();
    },
  );
  it('publishes the exact browser-safe unsafe ABI 2 contract and strict bounds', () => {
    expect(SLACK_SEND_MESSAGE_MANIFEST).toMatchObject({
      definition: { key: 'slack.send_message', version: 1 },
      executor: { key: 'slack.send_message', version: 1 },
      executorAbi: 2,
      retryClass: 'unsafe',
      resourceClass: 'io',
      integration: { providerKey: 'slack', operationKey: 'send_message' },
      connectionRequirements: ['slack_bot_token'],
    });
    expect(
      slackSendMessageInputSchema.safeParse({ channelId: 'C1', text: 'x' })
        .success,
    ).toBe(true);
    for (const invalid of [
      { channelId: 'c1', text: 'x' },
      { channelId: 'C1', text: '' },
      { channelId: 'C1', text: 'x'.repeat(4_001) },
      { channelId: 'C1', text: 'x', blocks: [] },
    ])
      expect(slackSendMessageInputSchema.safeParse(invalid).success).toBe(
        false,
      );
  });
  it('fences the current token immediately before dispatch and clears secret bytes', async () => {
    const state = runtime({
      kind: 'succeeded',
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    });
    const registration = createSlackSendMessageExecutorRegistration({
      client: { sendMessage: state.sendMessage },
    });
    await expect(
      registration.execute(invocation(state.value)),
    ).resolves.toEqual({
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    });
    expect(state.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ secretVersionId }),
    );
    expect(state.beforeDispatch).toHaveBeenCalledOnce();
    expect(state.value.observeConnectionHealth).toHaveBeenCalledExactlyOnceWith(
      { kind: 'healthy' },
    );
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
  });
  it('atomically forwards the resolved connection fence after a rotation race', async () => {
    const state = runtime({
      kind: 'succeeded',
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    });
    const rotatedSecretVersionId = '88888888-8888-4888-8888-888888888888';
    let currentSecretVersionId = secretVersionId;
    let providerBytesSent = false;
    state.assertCurrent.mockImplementationOnce((input) => {
      expect(input.secretVersionId).toBe(secretVersionId);
      currentSecretVersionId = rotatedSecretVersionId;
      return Promise.resolve();
    });
    state.beforeDispatch.mockImplementation((input) => {
      // The old provider adapter omitted the fence, so this test double
      // models a marker implementation that cannot reject a stale dispatch.
      if (input?.connectionFence === undefined) return Promise.resolve();
      if (
        input.providerDispatchBinding !==
        'slack:sha256:5a5537627ed92f258340d3ef1cf1f4ad8af19a67f1bc5a7bc91ab6c4154f4abb'
      )
        throw new NodeDispatchEvidenceError(
          'provider_dispatch_binding_mismatch',
        );
      if (input.connectionFence.secretVersionId !== currentSecretVersionId)
        throw new NodeDispatchEvidenceError('provider_connection_fence_failed');
      return Promise.resolve();
    });
    state.sendMessage.mockImplementation(async (input) => {
      await input.beforeDispatch();
      providerBytesSent = true;
      return {
        kind: 'succeeded',
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      };
    });

    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: state.sendMessage },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'authentication',
      possiblyDispatched: false,
    });
    expect(providerBytesSent).toBe(false);
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
    expect(state.beforeDispatch).toHaveBeenCalledWith({
      connectionFence: {
        connectionId,
        expectedProviderKey: 'slack',
        expectedAuthType: 'slack_bot_token',
        secretVersionId,
      },
      providerDispatchBinding:
        'slack:sha256:5a5537627ed92f258340d3ef1cf1f4ad8af19a67f1bc5a7bc91ab6c4154f4abb',
    });
  });
  it('fails closed when durable dispatch evidence cannot be recorded', async () => {
    const state = runtime({
      kind: 'succeeded',
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    });
    state.beforeDispatch.mockRejectedValueOnce(new Error('database down'));

    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: state.sendMessage },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'provider',
      possiblyDispatched: false,
    });
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
  });
  it.each([
    [
      'provider_dispatch_binding_mismatch',
      { kind: 'failed', errorKind: 'configuration', possiblyDispatched: false },
    ],
    [
      'provider_connection_fence_failed',
      {
        kind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
      },
    ],
  ] as const)(
    'maps dispatch evidence failure %s before provider bytes',
    async (code, expected) => {
      const state = runtime({
        kind: 'succeeded',
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      });
      state.beforeDispatch.mockRejectedValueOnce(
        new NodeDispatchEvidenceError(code),
      );

      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject(expected);
      expect(state.value.observeConnectionHealth).not.toHaveBeenCalled();
    },
  );
});
