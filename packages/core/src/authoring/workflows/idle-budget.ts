import { AUTHORING_VALIDATION_BUDGET } from '@pertexo/workflow-model/server';

const parserWaitMs =
  AUTHORING_VALIDATION_BUDGET.queueMs +
  AUTHORING_VALIDATION_BUDGET.startupMs +
  AUTHORING_VALIDATION_BUDGET.parseMs +
  AUTHORING_VALIDATION_BUDGET.terminationMs;

/** The connection's idle-in-transaction timeout, in milliseconds, outlasts the off-thread wait. */
export function authoringIdleBudgetIsSafe(millis: number | undefined): boolean {
  // Zero means unlimited, not evidence of a bounded effective deadline.
  return (
    millis !== undefined &&
    Number.isSafeInteger(millis) &&
    millis > parserWaitMs
  );
}
