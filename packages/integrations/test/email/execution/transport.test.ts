import { describe, expect, it } from 'vitest';

import {
  createEmailSendNotificationExecutorRegistration,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '../../../src/server.js';

import {
  secretVersionId,
  originalBinding,
  runtime,
  invocation,
} from '../../support/email-execution.js';
describe('email.send_notification@1', () => {
  it('retries pre/post-dispatch transport failures and preserves cancellation', async () => {
    for (const [error, expected] of [
      [
        new SecureHttpError(
          SECURE_HTTP_ERROR_CODE.dnsFailed,
          'definite_failure',
          { possiblyDispatched: false },
        ),
        { kind: 'retry', errorKind: 'network', possiblyDispatched: false },
      ],
      [
        new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', {
          possiblyDispatched: true,
        }),
        { kind: 'retry', errorKind: 'timeout', possiblyDispatched: true },
      ],
      [
        new SecureHttpError(SECURE_HTTP_ERROR_CODE.canceled, 'ambiguous', {
          possiblyDispatched: true,
        }),
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
        { possiblyDispatched: false },
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
  it('preserves earlier dispatch ambiguity for an unexpected adapter failure', async () => {
    const state = runtime(
      new Error('provider adapter failed'),
      secretVersionId,
      originalBinding,
      true,
    );
    await expect(
      createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
  });
  it('keeps one definite 429 adapter response unambiguous with a persisted binding', async () => {
    const executor = createEmailSendNotificationExecutorRegistration({
      client: {
        sendNotification: async (request) => {
          await request.beforeDispatch();
          return { kind: 'rate_limited', retryAfterMillis: 1_000 } as const;
        },
      },
    });

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
  });
});
