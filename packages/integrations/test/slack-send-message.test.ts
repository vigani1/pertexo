import {
  NodeDispatchEvidenceError,
  ProviderExecutionRateLimitError,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
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
  SlackSendMessageExecutorError,
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
    },
  );

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
    [429, {}, '{}', { kind: 'rate_limited', retryAfterMillis: 1_000 }],
    [
      429,
      { 'retry-after': 'invalid' },
      '{}',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
    ],
    [
      429,
      { 'retry-after': '0' },
      '{}',
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
    ],
    [500, {}, '{}', { kind: 'http_failure', status: 500 }],
    [200, {}, '{', { kind: 'invalid_response' }],
    [200, {}, '{"ok":"yes"}', { kind: 'invalid_response' }],
    [200, {}, '{"ok":false}', { kind: 'invalid_response' }],
    [
      200,
      {},
      '{"ok":false,"error":"invalid_auth"}',
      { kind: 'rejected', error: 'invalid_auth' },
    ],
    [200, {}, '{"ok":true}', { kind: 'invalid_response' }],
  ] as const)(
    'classifies send-message HTTP %s response %s without retaining provider bytes',
    async (status, headers, payload, expected) => {
      const body = new TextEncoder().encode(payload);
      const client = createSlackClient({
        execute: (request) => {
          expect(request.signal).toBeInstanceOf(AbortSignal);
          return Promise.resolve({
            status,
            headers,
            body,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          });
        },
      });

      await expect(
        client.sendMessage({
          botToken: 'xoxb-123456789-secret',
          channelId: 'C123ABC',
          text: 'deployment complete',
          timeoutMillis: 30_000,
          signal: new AbortController().signal,
          beforeDispatch: () => Promise.resolve(),
        }),
      ).resolves.toEqual(expected);
      expect(body.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([
    [500, '{}', { kind: 'http_failure', status: 500 }],
    [200, '{', { kind: 'invalid_response' }],
    [200, '{"ok":"yes"}', { kind: 'invalid_response' }],
    [200, '{"ok":true}', { kind: 'succeeded' }],
    [200, '{"ok":false}', { kind: 'invalid_response' }],
    [
      200,
      '{"ok":false,"error":"invalid_auth"}',
      { kind: 'rejected', error: 'invalid_auth' },
    ],
  ] as const)(
    'classifies auth-test HTTP %s response with a caller signal',
    async (status, payload, expected) => {
      const body = new TextEncoder().encode(payload);
      const client = createSlackClient({
        execute: (request) => {
          expect(request.signal).toBeInstanceOf(AbortSignal);
          return Promise.resolve({
            status,
            headers: {},
            body,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          });
        },
      });

      await expect(
        client.authTest({
          botToken: 'xoxb-123456789-secret',
          timeoutMillis: 30_000,
          signal: new AbortController().signal,
          beforeDispatch: () => Promise.resolve(),
        }),
      ).resolves.toEqual(expected);
      expect(body.every((byte) => byte === 0)).toBe(true);
    },
  );

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
    [
      { kind: 'invalid_response' },
      {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
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

  it.each([
    [
      SECURE_HTTP_ERROR_CODE.connectionFenceFailed,
      false,
      {
        kind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
      },
    ],
    [
      SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch,
      false,
      { kind: 'failed', errorKind: 'configuration', possiblyDispatched: false },
    ],
    [
      SECURE_HTTP_ERROR_CODE.canceled,
      false,
      { kind: 'canceled', errorKind: 'canceled', possiblyDispatched: false },
    ],
    [
      SECURE_HTTP_ERROR_CODE.canceled,
      true,
      {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      },
    ],
    [
      SECURE_HTTP_ERROR_CODE.timedOut,
      false,
      { kind: 'retry', errorKind: 'timeout', possiblyDispatched: false },
    ],
    [
      SECURE_HTTP_ERROR_CODE.networkFailed,
      true,
      {
        kind: 'outcome_unknown',
        errorKind: 'network',
        possiblyDispatched: true,
      },
    ],
  ] as const)(
    'maps secure HTTP %s with dispatched=%s at the executor boundary',
    async (code, possiblyDispatched, expected) => {
      const state = runtime(
        new SecureHttpError(
          code,
          possiblyDispatched ? 'ambiguous' : 'definite_failure',
          possiblyDispatched,
        ),
      );

      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject(expected);
    },
  );

  it('preserves known executor failures and rejects a mismatched provider response', async () => {
    const known = runtime(
      new SlackSendMessageExecutorError({
        kind: 'retry',
        errorKind: 'provider',
        possiblyDispatched: false,
      }),
    );
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: known.sendMessage },
      }).execute(invocation(known.value)),
    ).rejects.toBeInstanceOf(SlackSendMessageExecutorError);

    const mismatched = runtime({
      kind: 'succeeded',
      channelId: 'COTHER',
      messageTs: '1724412345.000100',
    });
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: mismatched.sendMessage },
      }).execute(invocation(mismatched.value)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
  });

  it('fails closed on rate-limited resolution and mismatched resolved credentials', async () => {
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
      retryAfterMillis: 7_000,
      possiblyDispatched: false,
    });

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
  });
});
