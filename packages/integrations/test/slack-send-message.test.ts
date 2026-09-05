import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

import {
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_MANIFEST,
  slackSendMessageInputSchema,
} from '../src/index.js';
import {
  createSlackSendMessageExecutorRegistration,
  createSlackClient,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpRequest,
  type SecureHttpResponse,
} from '../src/server.js';

const connectionId = '22222222-2222-4222-8222-222222222222';
const secretVersionId = '33333333-3333-4333-8333-333333333333';

function runtime(clientResult: unknown) {
  const secret = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      type: 'slack_bot_token',
      botToken: 'xoxb-123456789-secret',
    }),
  );
  const beforeDispatch = vi.fn(() => Promise.resolve());
  const assertCurrent = vi.fn(() => Promise.resolve());
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
  const sendMessage = vi.fn(
    async (input: { beforeDispatch(): Promise<void> }) => {
      await input.beforeDispatch();
      if (clientResult instanceof Error) throw clientResult;
      return clientResult as never;
    },
  );
  return { assertCurrent, beforeDispatch, secret, sendMessage, value };
}

function invocation(value: NodeExecutionRuntime) {
  return {
    config: { timeoutMillis: 10_000 },
    input: { channelId: 'C123ABC', text: 'deployment complete' },
    connectionRefs: { [SLACK_BOT_TOKEN_CONNECTION_SLOT]: connectionId },
    signal: new AbortController().signal,
    runtime: value,
  };
}

describe('slack.send_message@1', () => {
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
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
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
      errorKind: 'network',
      possiblyDispatched: false,
    });
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
  });

  it('uses only the fixed endpoint, one bounded request, no redirects, and inaccessible unfurls', async () => {
    let requestBody: Uint8Array | undefined;
    const execute = vi.fn(
      async (request: SecureHttpRequest): Promise<SecureHttpResponse> => {
        requestBody =
          request.body === undefined ? undefined : new Uint8Array(request.body);
        expect(request).toMatchObject({
          url: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          maxRedirects: 0,
          maxResponseBytes: 65_536,
          timeoutMillis: 30_000,
          sensitiveValues: ['xoxb-123456789-secret'],
        });
        await request.beforeDispatch();
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({
              ok: true,
              channel: 'C123ABC',
              ts: '1724412345.000100',
              token: 'must-not-parse',
            }),
          ),
          bodyEncoding: 'utf8' as const,
          finalUrl: 'https://slack.com',
          redirectCount: 0,
        };
      },
    );
    const result = await createSlackClient({ execute }).sendMessage({
      botToken: 'xoxb-123456789-secret',
      channelId: 'C123ABC',
      text: 'deployment complete',
      timeoutMillis: 30_000,
      signal: new AbortController().signal,
      beforeDispatch: () => Promise.resolve(),
    });
    expect(result).toEqual({
      kind: 'succeeded',
      channelId: 'C123ABC',
      messageTs: '1724412345.000100',
    });
    expect(JSON.parse(new TextDecoder().decode(requestBody))).toEqual({
      channel: 'C123ABC',
      text: 'deployment complete',
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('bounds Retry-After and performs fixed auth.test without a caller URL', async () => {
    const execute = vi.fn(
      (request: SecureHttpRequest): Promise<SecureHttpResponse> =>
        Promise.resolve({
          status: 429,
          headers: { 'retry-after': '999999999' },
          body: new TextEncoder().encode('{}'),
          bodyEncoding: 'utf8' as const,
          finalUrl: request.url,
          redirectCount: 0,
        }),
    );
    await expect(
      createSlackClient({ execute }).authTest({
        botToken: 'xoxb-123456789-secret',
        timeoutMillis: 15_000,
        beforeDispatch: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ kind: 'rate_limited', retryAfterMillis: 300_000 });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://slack.com/api/auth.test',
        maxRedirects: 0,
      }),
    );
  });

  it.each([
    [
      { kind: 'rejected', error: 'invalid_auth' },
      {
        kind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
      },
    ],
    [
      { kind: 'rejected', error: 'channel_not_found' },
      { kind: 'failed', errorKind: 'provider', possiblyDispatched: false },
    ],
    [
      { kind: 'rate_limited', retryAfterMillis: 300_000 },
      {
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: false,
        retryAfterMillis: 300_000,
      },
    ],
    [
      { kind: 'rejected', error: 'service_unavailable' },
      { kind: 'retry', errorKind: 'provider', possiblyDispatched: false },
    ],
    [
      { kind: 'rejected', error: 'internal_error' },
      {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      },
    ],
    [
      { kind: 'http_failure', status: 503 },
      {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      },
    ],
    [
      { kind: 'http_failure', status: 401 },
      {
        kind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
      },
    ],
  ])('classifies provider result %j truthfully', async (result, expected) => {
    const state = runtime(result);
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: state.sendMessage },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject(expected);
  });

  it('retries definite pre-dispatch transport failure but never replays post-dispatch ambiguity', async () => {
    const definite = runtime(
      new SecureHttpError(
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        'definite_failure',
        false,
      ),
    );
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: definite.sendMessage },
      }).execute(invocation(definite.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'network',
      possiblyDispatched: false,
    });
    const ambiguous = runtime(
      new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', true),
    );
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: ambiguous.sendMessage },
      }).execute(invocation(ambiguous.value)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'timeout',
      possiblyDispatched: true,
    });
  });
});
