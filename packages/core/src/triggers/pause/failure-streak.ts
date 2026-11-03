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

export function pauseEvidence(
  legacyFailures: number,
  failures: readonly Readonly<{ runId: string }>[],
  threshold: number,
): Readonly<{ runId: string; failures: number }> | null {
  const reached = failures[Math.max(0, threshold - legacyFailures - 1)];
  return reached === undefined
    ? null
    : {
        runId: reached.runId,
        failures: Math.max(threshold, legacyFailures + 1),
      };
}
