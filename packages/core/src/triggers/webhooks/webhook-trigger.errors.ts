export class WebhookTriggerNotFoundError extends Error {
  public override readonly name = 'WebhookTriggerNotFoundError';
}
/** The trigger exists but can't take an endpoint in its current state. */
export class WebhookTriggerStateError extends Error {
  public override readonly name = 'WebhookTriggerStateError';
  public constructor(
    public readonly reason: 'setting_up' | 'provisioned' | 'unavailable',
  ) {
    super(`webhook.trigger_${reason}`);
  }
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
/** The workspace stayed full for this delivery's whole wait, so nothing started. */
export class WebhookIntakeBusyError extends Error {
  public override readonly name = 'WebhookIntakeBusyError';
  public readonly retryAfterSeconds = 5;

  public constructor() {
    super('webhook.intake_busy');
  }
}
export class WebhookIngressRateLimitExceededError extends Error {
  public override readonly name = 'WebhookIngressRateLimitExceededError';
  public constructor(public readonly retryAfterSeconds: number) {
    super('webhook.rate_limited');
  }
}
