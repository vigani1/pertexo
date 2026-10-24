export class WebhookTestEventError extends Error {
  override readonly name = 'WebhookTestEventError';
  constructor(
    readonly reason:
      'changed' | 'limit_reached' | 'unavailable' | 'value_invalid',
  ) {
    super(`webhook.test_${reason}`);
  }
}
