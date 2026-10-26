import { inlineBytes } from '../../support/artifact-runtime.js';

import { describe, expect, it, vi } from 'vitest';
import {
  EMAIL_SEND_NOTIFICATION_MANIFEST,
  providerEmailMailboxSchema,
  emailSendNotificationInputSchema,
} from '../../../src/index.js';
import {
  createEmailSendNotificationExecutorRegistration,
  createResendClient,
  type SecureHttpRequest,
  type SecureHttpResponse,
} from '../../../src/server.js';

import {
  connectionId,
  secretVersionId,
  providerIdempotencyKey,
  runtime,
  invocation,
} from '../../support/email-execution.js';
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
      capabilities: [
        'external_http',
        'side_effect_disclosure',
        'artifact_input',
      ],
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
        'email:sha256:0ce354bd20817f5bc1af31a6e1e49d96414a9b82ae484aec1486ae37761738ff',
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
        const bytes = inlineBytes(request.body);
        requests.push({
          ...request,
          ...(bytes === undefined ? {} : { body: new Uint8Array(bytes) }),
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
        JSON.parse(
          new TextDecoder().decode(inlineBytes(request.body)),
        ) as unknown,
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
    [400, {}, '{', { kind: 'http_failure', status: 400 }],
    [401, {}, '{', { kind: 'http_failure', status: 401 }],
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
          requestBody = inlineBytes(request.body);
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
});
