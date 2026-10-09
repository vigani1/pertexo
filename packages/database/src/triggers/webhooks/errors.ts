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
/** ADR 056: the workflow is paused; the verified delivery starts no run. */
export class WebhookWorkflowPausedError extends Error {
  public override readonly name = 'WebhookWorkflowPausedError';
  public constructor() {
    super('webhook.workflow_paused');
  }
}
export class WebhookIngressRateLimitExceededError extends Error {
  public override readonly name = 'WebhookIngressRateLimitExceededError';
  public constructor(public readonly retryAfterSeconds: number) {
    super('webhook.rate_limited');
  }
}
