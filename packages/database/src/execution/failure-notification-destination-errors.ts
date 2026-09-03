export type FailureNotificationDestinationErrorCode =
  'conflict' | 'idempotency_conflict' | 'not_found';

export class FailureNotificationDestinationError extends Error {
  public override readonly name = 'FailureNotificationDestinationError';
  public constructor(
    public readonly code: FailureNotificationDestinationErrorCode,
    message?: string,
  ) {
    super(message ?? `Failure notification destination ${code}`);
  }
}
