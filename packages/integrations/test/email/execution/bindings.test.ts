import { inlineBytes } from '../../support/artifact-runtime.js';
import { createHash } from 'node:crypto';
import {
  NodeDispatchEvidenceError,
  ProviderCredentialInvalidError,
} from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import {
  createEmailSendNotificationExecutorRegistration,
  createResendClient,
} from '../../../src/server.js';

import {
  connectionId,
  secretVersionId,
  providerIdempotencyKey,
  originalBinding,
  runtime,
  invocation,
} from '../../support/email-execution.js';
describe('email.send_notification@1', () => {
  it.each(
    [400, 401, 403, 422].flatMap((status) =>
      [
        { body: new Uint8Array(), bodyCase: 'empty' },
        { body: Uint8Array.of(0xff), bodyCase: 'invalid UTF-8' },
        { body: new TextEncoder().encode('{'), bodyCase: 'malformed JSON' },
        {
          body: new TextEncoder().encode('{"unexpected":true}'),
          bodyCase: 'unknown JSON',
        },
      ].map(({ body, bodyCase }) => ({
        status,
        body,
        bodyCase,
        errorKind:
          status === 401 || status === 403
            ? ('authentication' as const)
            : ('provider' as const),
      })),
    ),
  )(
    'preserves HTTP $status refusal truth for an $bodyCase body through client and executor',
    async ({ status, body, errorKind }) => {
      const directResponseBody = new Uint8Array(body);
      let directRequestBody: Uint8Array | undefined;
      const directClient = createResendClient({
        execute: async (request) => {
          directRequestBody = inlineBytes(request.body);
          await request.beforeDispatch();
          return {
            status,
            headers: {},
            body: directResponseBody,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          };
        },
      });
      await expect(
        directClient.sendNotification({
          apiKey: 're_123456789_secret',
          fromEmail: 'sender@example.com',
          toEmail: 'recipient@example.com',
          subject: 'Deployment complete',
          text: 'Production is healthy.',
          idempotencyKey: providerIdempotencyKey,
          timeoutMillis: 30_000,
          beforeDispatch: () => Promise.resolve(),
        }),
      ).resolves.toEqual({ kind: 'http_failure', status });
      expect(directRequestBody?.every((byte) => byte === 0)).toBe(true);
      expect(directResponseBody.every((byte) => byte === 0)).toBe(true);

      const executorResponseBody = new Uint8Array(body);
      let executorRequestBody: Uint8Array | undefined;
      const state = runtime(undefined);
      const executorClient = createResendClient({
        execute: async (request) => {
          executorRequestBody = inlineBytes(request.body);
          await request.beforeDispatch();
          return {
            status,
            headers: {},
            body: executorResponseBody,
            bodyEncoding: 'utf8',
            finalUrl: request.url,
            redirectCount: 0,
          };
        },
      });
      await expect(
        createEmailSendNotificationExecutorRegistration({
          client: executorClient,
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({
        kind: 'failed',
        errorKind,
        possiblyDispatched: false,
      });
      expect(executorRequestBody?.every((byte) => byte === 0)).toBe(true);
      expect(executorResponseBody.every((byte) => byte === 0)).toBe(true);
      expect(state.secret.every((byte) => byte === 0)).toBe(true);
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
        error: 'invalid_api_key',
        status: 401,
      },
      'failed',
      'authentication',
      false,
    ],
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
      `email:sha256:${createHash('sha256')
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
      new ProviderCredentialInvalidError(),
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
      errorKind: 'provider',
      possiblyDispatched: true,
    });
  });
});
