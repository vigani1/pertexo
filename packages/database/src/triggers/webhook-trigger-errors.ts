export class WebhookTriggerNotFoundError extends Error {
  public override readonly name = 'WebhookTriggerNotFoundError';
}
export class WebhookTriggerIdempotencyConflictError extends Error {
  public override readonly name = 'WebhookTriggerIdempotencyConflictError';
}
export class WebhookDeliveryReplayMismatchError extends Error {
  public override readonly name = 'WebhookDeliveryReplayMismatchError';
}
export class WebhookDeliveryIneligibleError extends Error {
  public override readonly name = 'WebhookDeliveryIneligibleError';
}
export class WebhookIngressRateLimitExceededError extends Error {
  public override readonly name = 'WebhookIngressRateLimitExceededError';
  public constructor(public readonly retryAfterSeconds: number) {
    super('webhook.rate_limited');
  }
}
