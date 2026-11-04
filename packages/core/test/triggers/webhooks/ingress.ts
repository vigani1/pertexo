import type { createWebhookTriggerStore } from '../../../src/triggers/webhooks/webhook-trigger.store.js';

import { webhook } from './webhooks-database.fixture.js';

export async function acceptWebhook(
  input: Parameters<
    ReturnType<typeof createWebhookTriggerStore>['acceptVerifiedDelivery']
  >[0],
) {
  const result = await webhook.acceptVerifiedDelivery(input);
  if (!('runId' in result))
    throw new Error('Expected an accepted webhook in this journey');
  return result;
}
