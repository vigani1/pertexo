import { describe, expect, it } from 'vitest';

import {
  createSlackSendMessageExecutorRegistration,
  SECURE_HTTP_ERROR_CODE,
  SlackSendMessageExecutorError,
  SecureHttpError,
} from '../../../src/server.js';

import { runtime, invocation } from '../../support/slack-execution.js';
describe('slack.send_message@1', () => {
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
        minimumRetryDelayMillis: 60_000,
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
  ] as const)(
    'classifies provider result %j truthfully',
    async (result, expected) => {
      const state = runtime(result);
      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject(expected);
    },
  );
  it('retries definite pre-dispatch transport failure but never replays post-dispatch ambiguity', async () => {
    const definite = runtime(
      new SecureHttpError(
        SECURE_HTTP_ERROR_CODE.dnsFailed,
        'definite_failure',
        { possiblyDispatched: false },
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
      new SecureHttpError(SECURE_HTTP_ERROR_CODE.timedOut, 'ambiguous', {
        possiblyDispatched: true,
      }),
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
    expect(definite.value.observeConnectionHealth).not.toHaveBeenCalled();
    expect(ambiguous.value.observeConnectionHealth).not.toHaveBeenCalled();
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
          { possiblyDispatched },
        ),
      );

      await expect(
        createSlackSendMessageExecutorRegistration({
          client: { sendMessage: state.sendMessage },
        }).execute(invocation(state.value)),
      ).rejects.toMatchObject(expected);
    },
  );
  it('preserves a known Slack executor failure identity', async () => {
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
  });
  it('rejects a mismatched Slack provider response channel as unknown', async () => {
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
  it('maps a hostile provider-adapter rejection to an opaque unsafe outcome', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    const state = runtime(undefined);
    state.sendMessage.mockImplementation(async (input) => {
      await input.beforeDispatch();
      revoke();
      // Deliberately model an untrusted adapter rejection.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw proxy;
    });

    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: state.sendMessage },
      }).execute(invocation(state.value)),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'network',
      possiblyDispatched: true,
    });
  });
  it('rejects a non-unsafe Slack runtime before provider dispatch', async () => {
    const invalidRuntime = runtime(undefined);
    invalidRuntime.value = Object.freeze({
      ...invalidRuntime.value,
      sideEffectClass: 'safe',
    });
    await expect(
      createSlackSendMessageExecutorRegistration({
        client: { sendMessage: invalidRuntime.sendMessage },
      }).execute(invocation(invalidRuntime.value)),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
    });
    expect(invalidRuntime.sendMessage).not.toHaveBeenCalled();
  });
});
