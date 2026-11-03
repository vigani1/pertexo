/** UTC timestamps include all six PostgreSQL fractional digits, so text order is time order. */
export type CompletionPosition = Readonly<{ endedAt: string; id: string }>;
export type TriggerOutcome = CompletionPosition &
  Readonly<{ runId: string; countsAsFailure: boolean }>;

export function compareCompletions(
  left: CompletionPosition,
  right: CompletionPosition,
): number {
  if (left.endedAt < right.endedAt) return -1;
  if (left.endedAt > right.endedAt) return 1;
  if (left.id < right.id) return -1;
  return left.id > right.id ? 1 : 0;
}

/** An older success clears only the opaque upgrade carry and failures before it. */
export function advanceSuccessWatermark(
  prior: CompletionPosition | null,
  outcomes: readonly TriggerOutcome[],
): CompletionPosition | null {
  let success = prior;
  for (const outcome of outcomes)
    if (
      !outcome.countsAsFailure &&
      (success === null || compareCompletions(outcome, success) > 0)
    )
      success = { endedAt: outcome.endedAt, id: outcome.id };
  return success;
}

/** ADR 056 records the current streak and its latest counted failure. */
export function pauseEvidence(
  consecutiveFailures: number,
  latestFailure: Readonly<{ runId: string }> | undefined,
  threshold: number,
): Readonly<{ runId: string; failures: number }> | null {
  return latestFailure === undefined || consecutiveFailures < threshold
    ? null
    : { runId: latestFailure.runId, failures: consecutiveFailures };
}
