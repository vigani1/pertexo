export class ScheduleTriggerError extends Error {
  public override readonly name = 'ScheduleTriggerError';
  public constructor(
    public readonly code: 'idempotency_conflict' | 'not_found',
  ) {
    super(
      code === 'not_found'
        ? 'Schedule trigger is not visible'
        : 'Schedule trigger idempotency key conflicts with another request',
    );
  }
}
