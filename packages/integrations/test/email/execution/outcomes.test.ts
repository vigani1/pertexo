import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createEmailSendNotificationExecutorRegistration,
  createResendClient,
  EmailSendNotificationExecutorError,
  SecureHttpClient,
  SecureHttpError,
} from '../../../src/server.js';
import { providerCredentialFailureCases } from '../../support/provider-credential-failure-cases.js';
import {
  secretVersionId,
  providerIdempotencyKey,
  originalBinding,
  runtime,
  invocation,
} from '../../support/email-execution.js';
describe('email.send_notification@1', () => {
  it('preserves an executor failure returned by an injected provider adapter', async () => {
    const state = runtime(
      new EmailSendNotificationExecutorError({
        kind: 'retry',
        errorKind: 'provider',
        possiblyDispatched: true,
      }),
    );

    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toBeInstanceOf(EmailSendNotificationExecutorError);
  });
  it('maps a hostile provider-adapter rejection without evaluating its prototype twice', async () => {
    const hostile = Object.defineProperties(
      Object.create(SecureHttpError.prototype),
      {
        code: {
          get: () => {
            throw new Error('secure-code-trap');
          },
        },
        classification: { value: 'ambiguous' },
        possiblyDispatched: { value: true },
      },
    ) as unknown;
    const state = runtime(undefined);
    state.sendNotification.mockImplementation(async (input) => {
      await input.beforeDispatch();
      // Deliberately model an untrusted adapter rejection.
      throw hostile;
    });

    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'network',
      possiblyDispatched: true,
    });
  });
  it.each(providerCredentialFailureCases)(
    'preserves $name without sending provider bytes',
    async ({ stage, error, kind, errorKind }) => {
      const state = runtime({
        kind: 'succeeded',
        emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
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
        createEmailSendNotificationExecutorRegistration({
          client: { sendNotification: state.sendNotification },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({ kind, errorKind, possiblyDispatched: false });
      expect(state.beforeDispatch).not.toHaveBeenCalled();
    },
  );
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
  it('reuses the identical email key after a malformed successful response', async () => {
    const keys: string[] = [];
    const responseBodies = [
      new TextEncoder().encode('{'),
      new TextEncoder().encode(
        JSON.stringify({ id: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' }),
      ),
    ];
    let call = 0;
    const client = createResendClient({
      execute: async (request) => {
        await request.beforeDispatch();
        keys.push(request.headers?.['idempotency-key'] ?? 'missing');
        const body = responseBodies[call];
        call += 1;
        if (body === undefined) throw new Error('Unexpected Resend call');
        return {
          status: 200,
          headers: {},
          body,
          bodyEncoding: 'utf8',
          finalUrl: request.url,
          redirectCount: 0,
        };
      },
    });
    const executor = createEmailSendNotificationExecutorRegistration({
      client,
    });
    const first = runtime(undefined);
    const retry = runtime(undefined, secretVersionId, originalBinding);

    await expect(
      executor.execute(invocation(first.value)),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
    await expect(executor.execute(invocation(retry.value))).resolves.toEqual({
      emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
    });
    expect(keys).toEqual([providerIdempotencyKey, providerIdempotencyKey]);
    for (const body of responseBodies)
      expect(body.every((byte) => byte === 0)).toBe(true);
  });
});
