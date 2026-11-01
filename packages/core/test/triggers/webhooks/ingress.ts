import type { createWebhookTriggerDatabase } from '../../../src/triggers/webhooks/store.js';

import { webhook } from './base.js';

export async function acceptWebhook(
  input: Parameters<
    ReturnType<typeof createWebhookTriggerDatabase>['acceptVerifiedDelivery']
  >[0],
) {
  const result = await webhook.acceptVerifiedDelivery(input);
  if (!('runId' in result))
    throw new Error('Expected an accepted webhook in this journey');
  return result;
}
