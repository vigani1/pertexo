export class IdempotencyRequestConflictError extends Error {
  public override readonly name: string = 'IdempotencyRequestConflictError';

  public constructor(message = 'request.idempotency_conflict') {
    super(message);
  }
}

/**
 * A stored receipt that no longer reads can't be answered from, and starting the run
 * again could repeat it, so the key is refused as a conflict, as `shared/receipts.ts`
 * does. The caller gets a new key to use, not a 500.
 */
export class IdempotencyRecordCorruptError extends IdempotencyRequestConflictError {
  public override readonly name = 'IdempotencyRecordCorruptError';

  public constructor() {
    super('Persisted workflow run acceptance is incomplete or invalid');
  }
}
