import { createHash } from 'node:crypto';

import {
  NodeDispatchEvidenceError,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

import {
  EMAIL_SEND_NOTIFICATION_MANIFEST,
  RESEND_API_KEY_CONNECTION_SLOT,
  providerEmailMailboxSchema,
  emailSendNotificationInputSchema,
} from '../src/index.js';
import {
  createEmailSendNotificationExecutorRegistration,
  createResendClient,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  SecureHttpError,
  type SecureHttpRequest,
  type SecureHttpResponse,
} from '../src/server.js';

const connectionId = '22222222-2222-4222-8222-222222222222';
const secretVersionId = '33333333-3333-4333-8333-333333333333';
const providerIdempotencyKey = 'pertexo:v1:resend:stable-key';
const originalBinding =
  'email:v1:sha256:0ce354bd20817f5bc1af31a6e1e49d96414a9b82ae484aec1486ae37761738ff';

function runtime(
  clientResult: unknown,
  resolvedSecretVersionId = secretVersionId,
  providerDispatchBinding?: string,
  providerDispatchUnresolved?: true,
) {
  const secret = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      type: 'resend_api_key',
      apiKey: 're_123456789_secret',
      fromEmail: 'Notifications@Example.COM',
    }),
  );
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const assertCurrent = vi.fn(() => Promise.resolve());
  const value: NodeExecutionRuntime = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '44444444-4444-4444-8444-444444444444',
    nodeRunId: '55555555-5555-4555-8555-555555555555',
    attemptId: '66666666-6666-4666-8666-666666666666',
    attemptNumber: 1,
    nodeId: 'email-node',
    invocationKey: 'email-node',
    sideEffectClass: 'idempotent_with_key',
    providerIdempotencyKey,
    ...(providerDispatchBinding === undefined
      ? {}
      : { providerDispatchBinding }),
    ...(providerDispatchUnresolved === undefined
      ? {}
      : { providerDispatchUnresolved }),
    beforeDispatch,
    connections: {
      assertCurrent,
      resolve: () =>
        Promise.resolve({
          connectionId,
          providerKey: 'email',
          authType: 'resend_api_key',
          secretVersionId: resolvedSecretVersionId,
          secret,
        }),
    },
  };
  const sendNotification = vi.fn(
    async (input: { beforeDispatch(): Promise<void> }) => {
      await input.beforeDispatch();
      if (clientResult instanceof Error) throw clientResult;
      return clientResult as never;
    },
  );
  return { assertCurrent, beforeDispatch, secret, sendNotification, value };
}

function invocation(value: NodeExecutionRuntime) {
  return {
    config: { timeoutMillis: 10_000 },
    input: {
      toEmail: 'Recipient@Example.COM',
      subject: 'Deployment complete',
      text: 'Production is healthy.',
    },
    connectionRefs: { [RESEND_API_KEY_CONNECTION_SLOT]: connectionId },
    signal: new AbortController().signal,
    runtime: value,
  };
}

describe('email.send_notification@1', () => {
  it('publishes the exact browser-safe idempotent ABI 2 contract and conservative mailbox bounds', () => {
    expect(EMAIL_SEND_NOTIFICATION_MANIFEST).toMatchObject({
      definition: { key: 'email.send_notification', version: 1 },
      executor: { key: 'email.send_notification', version: 1 },
      executorAbi: 2,
      retryClass: 'idempotent-with-key',
      resourceClass: 'io',
      integration: { providerKey: 'email', operationKey: 'send_notification' },
      connectionRequirements: ['resend_api_key'],
      capabilities: ['external_http', 'side_effect_disclosure'],
    });
    expect(providerEmailMailboxSchema.parse('Local@Example.COM')).toBe(
      'Local@example.com',
    );
    for (const invalid of [
      'Display Name <a@example.com>',
      'group:a@example.com;',
      '"quoted"@example.com',
      'a(comment)@example.com',
      'a..b@example.com',
      'a@example.com\r\nBcc:x@example.com',
      'a\0@example.com',
      'a@localhost',
      'missing-at.example.com',
      'a@@example.com',
      `${'a'.repeat(65)}@example.com`,
    ])
      expect(providerEmailMailboxSchema.safeParse(invalid).success).toBe(false);
    expect(
      emailSendNotificationInputSchema.safeParse({
        toEmail: 'a@example.com',
        subject: 'x',
        text: 'x',
      }).success,
    ).toBe(true);
    for (const invalid of [
      { toEmail: 'a@example.com', subject: '', text: 'x' },
      { toEmail: 'a@example.com', subject: 'x\nBcc: y', text: 'x' },
      { toEmail: 'a@example.com', subject: 'x', text: '' },
      { toEmail: 'a@example.com', subject: 'x', text: 'x', html: '<b>x</b>' },
    ])
      expect(emailSendNotificationInputSchema.safeParse(invalid).success).toBe(
        false,
      );
  });

  it('fences the current credential immediately before dispatch and clears secret bytes', async () => {
    const state = runtime({
      kind: 'succeeded',
      emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
    });
    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).resolves.toEqual({ emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' });
    expect(state.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ secretVersionId }),
    );
    expect(state.beforeDispatch).toHaveBeenCalledOnce();
    expect(state.beforeDispatch).toHaveBeenCalledWith({
      connectionFence: {
        connectionId,
        expectedAuthType: 'resend_api_key',
        expectedProviderKey: 'email',
        secretVersionId,
      },
      providerDispatchBinding:
        'email:v1:sha256:0ce354bd20817f5bc1af31a6e1e49d96414a9b82ae484aec1486ae37761738ff',
    });
    expect(state.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEmail: 'Notifications@example.com',
        toEmail: 'Recipient@example.com',
        idempotencyKey: providerIdempotencyKey,
      }),
    );
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
  });

  it('posts one exact bounded request to the fixed endpoint with a stable key and payload', async () => {
    const requests: SecureHttpRequest[] = [];
    const execute = vi.fn(
      async (request: SecureHttpRequest): Promise<SecureHttpResponse> => {
        requests.push({
          ...request,
          ...(request.body === undefined
            ? {}
            : { body: new Uint8Array(request.body) }),
        });
        await request.beforeDispatch();
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({ id: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' }),
          ),
          bodyEncoding: 'utf8',
          finalUrl: request.url,
          redirectCount: 0,
        };
      },
    );
    const client = createResendClient({ execute });
    const input = {
      apiKey: 're_123456789_secret',
      fromEmail: 'sender@example.com',
      toEmail: 'recipient@example.com',
      subject: 'Deployment complete',
      text: 'Production is healthy.',
      idempotencyKey: providerIdempotencyKey,
      timeoutMillis: 30_000,
      signal: new AbortController().signal,
      beforeDispatch: () => Promise.resolve(),
    };
    await expect(client.sendNotification(input)).resolves.toEqual({
      kind: 'succeeded',
      emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
    });
    await client.sendNotification(input);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({
      url: 'https://api.resend.com/emails',
      method: 'POST',
      maxRedirects: 0,
      maxResponseBytes: 65_536,
      timeoutMillis: 30_000,
      sensitiveValues: ['re_123456789_secret'],
      headers: {
        authorization: 'Bearer re_123456789_secret',
        'idempotency-key': providerIdempotencyKey,
      },
    });
    const bodies = requests.map(
      (request) =>
        JSON.parse(new TextDecoder().decode(request.body)) as unknown,
    );
    expect(bodies).toEqual([
      {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Deployment complete',
        text: 'Production is healthy.',
      },
      {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Deployment complete',
        text: 'Production is healthy.',
      },
    ]);
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
    [200, {}, '{', { kind: 'invalid_response' }],
    [200, {}, '{"id":"not-a-uuid"}', { kind: 'invalid_response' }],
    [
      400,
      {},
      '{"name":"validation_error"}',
      { kind: 'rejected', error: 'validation_error', status: 400 },
    ],
    [500, {}, '{}', { kind: 'http_failure', status: 500 }],
  ] as const)(
    'classifies Resend HTTP %s response and clears request and response bytes',
    async (status, headers, payload, expected) => {
      const responseBody = new TextEncoder().encode(payload);
      let requestBody: Uint8Array | undefined;
      const client = createResendClient({
        execute: (request) => {
          requestBody = request.body;
          expect(request.signal).toBeUndefined();
          return Promise.resolve({
            status,
            headers,
            body: responseBody,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          });
        },
      });

      await expect(
        client.sendNotification({
          apiKey: 're_123456789_secret',
          fromEmail: 'sender@example.com',
          toEmail: 'recipient@example.com',
          subject: 'Deployment complete',
          text: 'Production is healthy.',
          idempotencyKey: providerIdempotencyKey,
          timeoutMillis: 30_000,
          beforeDispatch: () => Promise.resolve(),
        }),
      ).resolves.toEqual(expected);
      expect(requestBody?.every((byte) => byte === 0)).toBe(true);
      expect(responseBody.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([
    [{ kind: 'http_failure', status: 400 }, 'failed', 'provider', false],
    [{ kind: 'http_failure', status: 401 }, 'failed', 'authentication', false],
    [{ kind: 'http_failure', status: 422 }, 'failed', 'provider', false],
    [
      { kind: 'rate_limited', retryAfterMillis: 300_000 },
      'retry',
      'rate_limit',
      false,
    ],
    [{ kind: 'http_failure', status: 503 }, 'retry', 'provider', true],
    [
      {
        kind: 'rejected',
        error: 'invalid_idempotent_request',
        status: 409,
      },
      'failed',
      'provider',
      false,
    ],
    [
      {
        kind: 'rejected',
        error: 'concurrent_idempotent_requests',
        status: 409,
      },
      'retry',
      'provider',
      true,
    ],
    [{ kind: 'invalid_response' }, 'retry', 'provider', true],
  ])(
    'classifies %j without unsafe unknown outcomes',
    async (result, kind, errorKind, possiblyDispatched) => {
      const state = runtime(result);
      await expect(
        createEmailSendNotificationExecutorRegistration({
          client: { sendNotification: state.sendNotification },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({ kind, errorKind, possiblyDispatched });
    },
  );

  it('keeps a parsed HTTP 400 provider refusal definite across the client seam', async () => {
    const state = runtime(undefined);
    const client = createResendClient({
      execute: async (request) => {
        await request.beforeDispatch();
        return {
          status: 400,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({ name: 'validation_error' }),
          ),
          bodyEncoding: 'utf8',
          finalUrl: request.url,
          redirectCount: 0,
        };
      },
    });

    await expect(
      createEmailSendNotificationExecutorRegistration({ client }).execute(
        invocation(state.value),
      ),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'provider',
      possiblyDispatched: false,
    });
  });

  it('fails a rotated dispatch binding before provider bytes without retrying', async () => {
    const rotatedSecretVersionId = '77777777-7777-4777-8777-777777777777';
    const state = runtime(
      {
        kind: 'succeeded',
        emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
      },
      rotatedSecretVersionId,
    );
    state.beforeDispatch.mockImplementationOnce((input) => {
      if (input?.providerDispatchBinding !== originalBinding)
        return Promise.reject(
          new NodeDispatchEvidenceError('provider_dispatch_binding_mismatch'),
        );
      return Promise.resolve();
    });

    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(
      state.beforeDispatch.mock.calls[0]?.[0]?.providerDispatchBinding,
    ).toBe(
      `email:v1:sha256:${createHash('sha256')
        .update(`email\0${connectionId}\0${rotatedSecretVersionId}`)
        .digest('hex')}`,
    );
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
  });

  it('fails a rotated or revoked credential at the final fence before provider bytes', async () => {
    const state = runtime({
      kind: 'succeeded',
      emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
    });
    state.assertCurrent.mockRejectedValueOnce(
      new Error('credential_not_current'),
    );

    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'authentication',
      possiblyDispatched: false,
    });
    expect(state.beforeDispatch).not.toHaveBeenCalled();
    expect(state.secret.every((byte) => byte === 0)).toBe(true);
  });

  it('reports historical ambiguity when retry credential resolution fails', async () => {
    const state = runtime(undefined, secretVersionId, originalBinding, true);
    const historicalRuntime = {
      ...state.value,
      connections: {
        ...state.value.connections,
        resolve: () => Promise.reject(new Error('credential_not_current')),
      },
    };

    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(historicalRuntime)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'authentication',
      possiblyDispatched: true,
    });
  });

  it('preserves dispatch identity through the real secure HTTP boundary', async () => {
    const transport = { dispatch: vi.fn() };
    const client = createResendClient(
      new SecureHttpClient(
        {
          resolve: () =>
            Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
        },
        transport,
      ),
    );
    const mismatch = runtime(undefined, secretVersionId, originalBinding, true);
    mismatch.beforeDispatch.mockRejectedValueOnce(
      new NodeDispatchEvidenceError('provider_dispatch_binding_mismatch'),
    );

    await expect(
      createEmailSendNotificationExecutorRegistration({ client }).execute(
        invocation(mismatch.value),
      ),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'configuration',
      possiblyDispatched: true,
    });
    expect(transport.dispatch).not.toHaveBeenCalled();

    const suspendedWorkspace = runtime(
      undefined,
      secretVersionId,
      originalBinding,
    );
    suspendedWorkspace.beforeDispatch.mockRejectedValueOnce(
      new NodeDispatchEvidenceError('provider_connection_fence_failed'),
    );
    await expect(
      createEmailSendNotificationExecutorRegistration({ client }).execute(
        invocation(suspendedWorkspace.value),
      ),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'authentication',
      possiblyDispatched: false,
    });
    expect(transport.dispatch).not.toHaveBeenCalled();

    const infrastructure = runtime(
      undefined,
      secretVersionId,
      originalBinding,
      true,
    );
    infrastructure.beforeDispatch.mockRejectedValueOnce(
      new Error('postgres_unavailable'),
    );
    await expect(
      createEmailSendNotificationExecutorRegistration({ client }).execute(
        invocation(infrastructure.value),
      ),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
    expect(transport.dispatch).not.toHaveBeenCalled();
  });

  it('replays the same binding, provider key, and payload after a post-dispatch crash', async () => {
    const first = runtime(undefined);
    const reclaimed = runtime(undefined);
    const dispatches: unknown[] = [];
    let crash = true;
    const executor = createEmailSendNotificationExecutorRegistration({
      client: {
        sendNotification: async (request) => {
          await request.beforeDispatch();
          dispatches.push({
            fromEmail: request.fromEmail,
            idempotencyKey: request.idempotencyKey,
            subject: request.subject,
            text: request.text,
            toEmail: request.toEmail,
          });
          if (crash) {
            crash = false;
            throw new Error('process_crashed_after_dispatch');
          }
          return {
            kind: 'succeeded' as const,
            emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
          };
        },
      },
    });

    await expect(
      executor.execute(invocation(first.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'network',
      possiblyDispatched: true,
    });
    await expect(
      executor.execute(invocation(reclaimed.value)),
    ).resolves.toEqual({
      emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
    });

    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toEqual(dispatches[0]);
    expect(first.beforeDispatch.mock.calls[0]?.[0]).toEqual(
      reclaimed.beforeDispatch.mock.calls[0]?.[0],
    );
    expect(first.secret.every((byte) => byte === 0)).toBe(true);
    expect(reclaimed.secret.every((byte) => byte === 0)).toBe(true);
  });

  it('retries pre/post-dispatch transport failures and preserves cancellation', async () => {
    for (const [error, expected] of [
      [
        new SecureHttpError(
          SECURE_HTTP_ERROR_CODE.dnsFailed,
          'definite_failure',
          false,
        ),
        { kind: 'retry', errorKind: 'network', possiblyDispatched: false },
      ],
      [
        new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', true),
        { kind: 'retry', errorKind: 'timeout', possiblyDispatched: true },
      ],
      [
        new SecureHttpError(SECURE_HTTP_ERROR_CODE.canceled, 'ambiguous', true),
        { kind: 'canceled', errorKind: 'canceled', possiblyDispatched: true },
      ],
    ] as const) {
      const state = runtime(error);
      await expect(
        createEmailSendNotificationExecutorRegistration({
          client: { sendNotification: state.sendNotification },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject(expected);
    }
  });

  it.each([
    { kind: 'http_failure', status: 401 },
    { kind: 'rate_limited', retryAfterMillis: 1_000 },
    { kind: 'http_failure', status: 503 },
    { kind: 'invalid_response' },
  ])(
    'preserves earlier dispatch ambiguity when a retry returns $kind',
    async (result) => {
      const state = runtime(result);
      state.value = Object.freeze({
        ...state.value,
        providerDispatchBinding: originalBinding,
        providerDispatchUnresolved: true,
      });
      await expect(
        createEmailSendNotificationExecutorRegistration({
          client: { sendNotification: state.sendNotification },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({
        kind: 'outcome_unknown',
        possiblyDispatched: true,
      });
    },
  );

  it('preserves earlier dispatch ambiguity when a retry fails before redispatch', async () => {
    const state = runtime(
      new SecureHttpError(
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        'definite_failure',
        false,
      ),
    );
    state.value = Object.freeze({
      ...state.value,
      providerDispatchBinding: originalBinding,
      providerDispatchUnresolved: true,
    });
    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      possiblyDispatched: true,
    });
  });

  it('keeps repeated definite 429 retries unambiguous despite a persisted binding', async () => {
    const executor = createEmailSendNotificationExecutorRegistration({
      client: {
        sendNotification: async (request) => {
          await request.beforeDispatch();
          return { kind: 'rate_limited', retryAfterMillis: 1_000 } as const;
        },
      },
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const state = runtime(
        { kind: 'rate_limited', retryAfterMillis: 1_000 },
        secretVersionId,
        originalBinding,
      );
      await expect(
        executor.execute(invocation(state.value)),
      ).rejects.toMatchObject({
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: false,
      });
    }
  });
});
