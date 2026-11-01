import type { createFailureNotificationStore } from '@pertexo/core/testing';

import { createFailureNotificationHandler } from '../../src/notifications/failure-handler.js';
import { createProviderFailureNotificationDelivery } from '../../src/notifications/failure-delivery.js';

export type EmailAnswer = (send: () => Promise<void>) => Promise<unknown>;

/** Every credential's ciphertext opens to a key named after it, so the provider call shows which one was used. */
export const FIRST_CIPHERTEXT = 'first-cipher';
export const ROTATED_CIPHERTEXT = 'rotated-cipher';

export function deliveryHarness(
  store: ReturnType<typeof createFailureNotificationStore>,
) {
  const emails: { apiKey: string; toEmail: string }[] = [];
  const slackMessages: { botToken: string; channelId: string }[] = [];
  const opened: string[] = [];
  const answers: EmailAnswer[] = [];
  const delivered: EmailAnswer = async (send) => {
    await send();
    return { kind: 'succeeded', emailId: 'email-reference' };
  };
  const handler = createFailureNotificationHandler({
    store,
    timeoutMillis: 30_000,
    maxAttempts: 2,
    retryDelaySeconds: 30,
    delivery: createProviderFailureNotificationDelivery({
      store,
      workerId: 'rotation-integration-worker',
      encryption: {
        open: (sealed) => {
          opened.push(sealed.ciphertext);
          return Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify(
                sealed.ciphertext.includes('slack')
                  ? {
                      type: 'slack_bot_token',
                      botToken: `xoxb-${sealed.ciphertext}`,
                    }
                  : {
                      type: 'resend_api_key',
                      apiKey: `re_${sealed.ciphertext}`,
                      fromEmail: 'sender@example.test',
                    },
              ),
            ),
          );
        },
      },
      slack: {
        sendMessage: async (input) => {
          await input.beforeDispatch();
          slackMessages.push({
            botToken: input.botToken,
            channelId: input.channelId,
          });
          return {
            kind: 'succeeded',
            channelId: input.channelId,
            messageTs: '1730000000.000100',
          };
        },
      },
      email: {
        sendNotification: async (input) => {
          const answer = answers.shift() ?? delivered;
          const result = await answer(() => input.beforeDispatch());
          emails.push({ apiKey: input.apiKey, toEmail: input.toEmail });
          return result as never;
        },
      },
    }),
  });
  return { emails, slackMessages, opened, answers, handler };
}
