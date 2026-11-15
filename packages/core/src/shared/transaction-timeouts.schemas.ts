import { z } from 'zod';

/** The bounds and default of one timeout option, in milliseconds. */
export type TimeoutBounds = Readonly<{
  minimum: number;
  maximum: number;
  default: number;
}>;

/** How long a maintenance transaction waits for a row or advisory lock. */
export const LOCK_TIMEOUT_MILLIS: TimeoutBounds = Object.freeze({
  minimum: 100,
  maximum: 300_000,
  default: 10_000,
});

/** How long one statement of a maintenance transaction may run. */
export const STATEMENT_TIMEOUT_MILLIS: TimeoutBounds = Object.freeze({
  minimum: 1_000,
  maximum: 300_000,
  default: 30_000,
});

/** A whole number of milliseconds within the bounds, defaulting to theirs. */
export function timeoutMillisSchema(bounds: TimeoutBounds) {
  return z
    .number()
    .int()
    .min(bounds.minimum)
    .max(bounds.maximum)
    .default(bounds.default);
}

/**
 * The lock and statement options of a flow that opens its own maintenance
 * transactions: the operator, retention and the lifecycle coordinators.
 */
export const transactionTimeoutsShape = Object.freeze({
  lockTimeoutMs: timeoutMillisSchema(LOCK_TIMEOUT_MILLIS),
  statementTimeoutMs: timeoutMillisSchema(STATEMENT_TIMEOUT_MILLIS),
});
