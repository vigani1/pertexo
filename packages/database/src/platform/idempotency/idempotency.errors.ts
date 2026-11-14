/** A command key was reused for a different request. */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
  constructor() {
    super('Idempotency key was used for a different request');
  }
}
