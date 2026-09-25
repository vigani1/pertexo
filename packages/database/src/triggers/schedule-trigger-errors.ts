const MESSAGES = Object.freeze({
  not_found: 'Schedule trigger is not visible',
  idempotency_conflict:
    'Schedule trigger idempotency key conflicts with another request',
  invalid_recurrence: 'Schedule recurrence cannot be scheduled',
} as const);

export class ScheduleTriggerError extends Error {
  public override readonly name = 'ScheduleTriggerError';
  public constructor(
    public readonly code: keyof typeof MESSAGES,
    options?: ErrorOptions,
  ) {
    super(MESSAGES[code], options);
  }
}
