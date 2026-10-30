import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import { createEmailSendNotificationExecutorRegistration } from '../../../src/server.js';

import {
  connectionId,
  secretVersionId,
  originalBinding,
  runtime,
  invocation,
} from '../../support/email-execution.js';
describe('email.send_notification@1', () => {
  it.each([
    {
      name: 'invalid credential without history',
      error: new ProviderCredentialInvalidError(),
      historical: false,
      expected: {
        kind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
      },
    },
    {
      name: 'throttle without history',
      error: new ProviderExecutionRateLimitError(7),
      historical: false,
      expected: {
        kind: 'retry',
        errorKind: 'rate_limit',
        possiblyDispatched: false,
        minimumRetryDelayMillis: 7_000,
      },
    },
    {
      name: 'throttle with history',
      error: new ProviderExecutionRateLimitError(7),
      historical: true,
      expected: {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      },
    },
    {
      name: 'cancellation without history',
      error: Object.assign(new Error('resolution canceled'), {
        name: 'AbortError',
      }),
      historical: false,
      expected: {
        kind: 'canceled',
        errorKind: 'canceled',
        possiblyDispatched: false,
      },
    },
    {
      name: 'cancellation with history',
      error: Object.assign(new Error('resolution canceled'), {
        name: 'AbortError',
      }),
      historical: true,
      expected: {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      },
    },
    {
      name: 'transient failure without history',
      error: new Error('connection resolver unavailable'),
      historical: false,
      expected: {
        kind: 'retry',
        errorKind: 'provider',
        possiblyDispatched: false,
      },
    },
    {
      name: 'transient failure with history',
      error: new Error('connection resolver unavailable'),
      historical: true,
      expected: {
        kind: 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      },
    },
  ])(
    'applies resolution precedence for $name without provider I/O',
    async ({ error, historical, expected }) => {
      const state = runtime(
        undefined,
        secretVersionId,
        historical ? originalBinding : undefined,
        historical ? true : undefined,
      );
      state.value = Object.freeze({
        ...state.value,
        connections: {
          assertCurrent: state.assertCurrent,
          resolve: () => Promise.reject(error),
        },
      });

      await expect(
        createEmailSendNotificationExecutorRegistration({
          client: { sendNotification: state.sendNotification },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject(expected);
      expect(state.sendNotification).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      name: 'connection identity',
      mutate: (state: ReturnType<typeof runtime>) => ({
        connectionId: '77777777-7777-4777-8777-777777777777',
        providerKey: 'email',
        authType: 'resend_api_key',
        secretVersionId,
        secret: state.secret,
      }),
      errorKind: 'configuration',
    },
    {
      name: 'credential decode',
      mutate: (state: ReturnType<typeof runtime>) => ({
        connectionId,
        providerKey: 'email',
        authType: 'resend_api_key',
        secretVersionId,
        secret: (state.secret = Uint8Array.of(0xff)),
      }),
      errorKind: 'authentication',
    },
  ])(
    'preserves historical uncertainty for resolved $name failure',
    async ({ mutate, errorKind }) => {
      const state = runtime(undefined, secretVersionId, originalBinding, true);
      state.value = Object.freeze({
        ...state.value,
        connections: {
          assertCurrent: state.assertCurrent,
          resolve: () => Promise.resolve(mutate(state)),
        },
      });

      await expect(
        createEmailSendNotificationExecutorRegistration({
          client: { sendNotification: state.sendNotification },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject({
        kind: 'outcome_unknown',
        errorKind,
        possiblyDispatched: true,
      });
      expect(state.secret.every((byte) => byte === 0)).toBe(true);
      expect(state.sendNotification).not.toHaveBeenCalled();
    },
  );
  it('reports historical ambiguity when the retry lacks a credential fence', async () => {
    const state = runtime(undefined, secretVersionId, originalBinding, true);
    const { connections, ...withoutConnections } = state.value;
    expect(connections).toBeDefined();
    state.value = Object.freeze(withoutConnections);

    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'authentication',
      possiblyDispatched: true,
    });
    expect(state.sendNotification).not.toHaveBeenCalled();
  });
  it('rejects a non-idempotent email runtime before provider dispatch', async () => {
    const invalidRuntime = runtime(undefined);
    invalidRuntime.value = Object.freeze({
      ...invalidRuntime.value,
      sideEffectClass: 'unsafe',
    });
    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: invalidRuntime.sendNotification },
      }).execute(invocation(invalidRuntime.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(invalidRuntime.sendNotification).not.toHaveBeenCalled();
  });
  it('rejects an email runtime without a final credential fence', async () => {
    const missingFence = runtime(undefined);
    const connections = missingFence.value.connections;
    if (connections === undefined)
      throw new Error('Expected the runtime fixture to include connections');
    const resolve = connections.resolve.bind(connections);
    missingFence.value = Object.freeze({
      ...missingFence.value,
      connections: { resolve },
    });
    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: missingFence.sendNotification },
      }).execute(invocation(missingFence.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'authentication',
      possiblyDispatched: false,
    });
    expect(missingFence.sendNotification).not.toHaveBeenCalled();
  });
  it('rejects a mismatched resolved email credential before provider dispatch', async () => {
    const mismatched = runtime(undefined);
    mismatched.value = Object.freeze({
      ...mismatched.value,
      connections: {
        assertCurrent: mismatched.assertCurrent,
        resolve: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'slack',
            authType: 'resend_api_key',
            secretVersionId,
            secret: mismatched.secret,
          }),
      },
    });
    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: mismatched.sendNotification },
      }).execute(invocation(mismatched.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(mismatched.sendNotification).not.toHaveBeenCalled();
  });
});
