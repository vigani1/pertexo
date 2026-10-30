import {
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import {
  createEmailSendNotificationExecutorRegistration,
  createSlackSendMessageExecutorRegistration,
} from '../../src/server.js';
import * as email from '../support/email-execution.js';
import * as slack from '../support/slack-execution.js';

// Email and Slack classify provider failures the same way: the same failure
// reaches the engine whichever provider the step calls.
const providers = {
  email: {
    throttled(retryAfterMillis: number) {
      const state = email.runtime({ kind: 'rate_limited', retryAfterMillis });
      return createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(email.invocation(state.value));
    },
    lookupFails(error: Error, unresolved: boolean) {
      const state = email.runtime(
        undefined,
        email.secretVersionId,
        unresolved ? email.originalBinding : undefined,
        unresolved ? true : undefined,
      );
      return createEmailSendNotificationExecutorRegistration({
        client: { sendNotification: state.sendNotification },
      }).execute(
        email.invocation(
          Object.freeze({
            ...state.value,
            connections: {
              assertCurrent: state.assertCurrent,
              resolve: () => Promise.reject(error),
            },
          }),
        ),
      );
    },
  },
  slack: {
    throttled(retryAfterMillis: number) {
      const state = slack.runtime({ kind: 'rate_limited', retryAfterMillis });
      return createSlackSendMessageExecutorRegistration({
        client: { sendMessage: state.sendMessage },
      }).execute(slack.invocation(state.value));
    },
    lookupFails(error: Error, unresolved: boolean) {
      const state = slack.runtime(undefined);
      return createSlackSendMessageExecutorRegistration({
        client: { sendMessage: state.sendMessage },
      }).execute(
        slack.invocation(
          Object.freeze({
            ...state.value,
            ...(unresolved ? { providerDispatchUnresolved: true } : {}),
            connections: {
              assertCurrent: state.assertCurrent,
              resolve: () => Promise.reject(error),
            },
          }),
        ),
      );
    },
  },
} as const;

describe.each(Object.entries(providers))('%s failures', (_, provider) => {
  // A service may ask for a longer wait, but never more than one minute
  // (docs/guides/step-retries.md).
  it('caps a requested retry delay at one minute', async () => {
    await expect(provider.throttled(300_000)).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'rate_limit',
      possiblyDispatched: false,
      minimumRetryDelayMillis: 60_000,
    });
  });

  it('fails an invalid credential without an earlier dispatch', async () => {
    await expect(
      provider.lookupFails(new ProviderCredentialInvalidError(), false),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'authentication',
      possiblyDispatched: false,
    });
  });

  it('keeps an earlier unresolved dispatch uncertain after a throttled lookup', async () => {
    await expect(
      provider.lookupFails(new ProviderExecutionRateLimitError(7), true),
    ).rejects.toMatchObject({
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
  });
});

describe('an invalid credential after an earlier unresolved dispatch', () => {
  const expected = {
    kind: 'outcome_unknown',
    errorKind: 'provider',
    possiblyDispatched: true,
  };

  it('leaves the earlier Slack call uncertain', async () => {
    await expect(
      providers.slack.lookupFails(new ProviderCredentialInvalidError(), true),
    ).rejects.toMatchObject(expected);
  });

  it('leaves the earlier email call uncertain', async () => {
    await expect(
      providers.email.lookupFails(new ProviderCredentialInvalidError(), true),
    ).rejects.toMatchObject(expected);
  });
});
