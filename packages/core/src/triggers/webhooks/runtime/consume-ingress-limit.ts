import { withPlatformTransaction } from '@pertexo/database/platform';
import type { Pool } from 'pg';
import { WebhookIngressRateLimitExceededError } from '../webhook-trigger.errors.js';
import {
  lockWebhookIngressCounter,
  storeWebhookIngressCounter,
} from './verification.repository.js';

/** The window an endpoint's burst limit counts requests in. */
const INGRESS_WINDOW_MILLIS = 60_000;

export async function consumeWebhookIngressLimit(
  pool: Pool,
  endpointKeyHashInput: string,
  burstLimit: number,
): Promise<void> {
  const retryAfter = await withPlatformTransaction(pool, async (client) => {
    const counter = await lockWebhookIngressCounter(
      client,
      endpointKeyHashInput,
    );
    if (counter === undefined) return 1;
    const remainingMillis =
      Date.parse(counter.bucket_started_at) +
      INGRESS_WINDOW_MILLIS -
      Date.parse(counter.observed_at);
    const reset = counter.created || remainingMillis <= 0;
    if (!reset && counter.request_count >= burstLimit)
      return Math.max(
        1,
        Math.min(
          INGRESS_WINDOW_MILLIS / 1_000,
          Math.ceil(remainingMillis / 1_000),
        ),
      );
    const window = reset ? counter.observed_at : counter.bucket_started_at;
    if (
      !(await storeWebhookIngressCounter(
        client,
        endpointKeyHashInput,
        counter,
        { reset, window },
      ))
    )
      throw new Error('Webhook ingress counter ownership changed');
    return 0;
  });
  if (retryAfter > 0)
    throw new WebhookIngressRateLimitExceededError(retryAfter);
}
