export const PREVIEW_STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  timedOut: 'timed_out',
  outcomeUnknown: 'outcome_unknown',
});

export const TERMINAL_PREVIEW_STATUSES: ReadonlySet<string> = new Set([
  PREVIEW_STATUS.canceled,
  PREVIEW_STATUS.failed,
  PREVIEW_STATUS.outcomeUnknown,
  PREVIEW_STATUS.succeeded,
  PREVIEW_STATUS.timedOut,
]);

const PREVIEW_STATUS_PAIRS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    canceled: new Set([PREVIEW_STATUS.canceled]),
    failed: new Set([PREVIEW_STATUS.failed]),
    outcome_unknown: new Set([PREVIEW_STATUS.outcomeUnknown]),
    queued: new Set([PREVIEW_STATUS.queued]),
    running: new Set([PREVIEW_STATUS.queued, PREVIEW_STATUS.running]),
    succeeded: new Set([PREVIEW_STATUS.succeeded]),
    timed_out: new Set([PREVIEW_STATUS.timedOut]),
  });

export function previewPairConsistent(
  attemptStatus: string,
  runStatus: string,
): boolean {
  if (!Object.hasOwn(PREVIEW_STATUS_PAIRS, attemptStatus)) return false;
  return PREVIEW_STATUS_PAIRS[attemptStatus]?.has(runStatus) ?? false;
}

/** Not yet finished: the only states a terminal or reclaiming write may leave. */
export const UNFINISHED_PREVIEW_STATUSES = [
  PREVIEW_STATUS.queued,
  PREVIEW_STATUS.running,
];

/** An unsafe step that may have reached its provider can't safely run again. */
export function mayHaveDispatchedUnsafely(
  attempt: Readonly<{ dispatchMarkedAt: Date | null; sideEffectClass: string }>,
): boolean {
  return (
    attempt.dispatchMarkedAt !== null && attempt.sideEffectClass === 'unsafe'
  );
}
