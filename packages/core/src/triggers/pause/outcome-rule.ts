const COUNTED_TRIGGERS: ReadonlySet<string> = new Set([
  'schedule',
  'webhook',
  'form',
]);
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
  'outcome_unknown',
]);

/**
 * What a finished run means for its workflow's failure streak (ADR 056). A success
 * resets it. A canceled run, and runs started by hand, through the API or as replays,
 * don't count either way, and nor does a run whose time ran out while it queued for
 * capacity: overload is the platform's problem, and it shouldn't switch off a trigger.
 */
export function streakOutcome(run: {
  triggerType: string;
  cancellationRequested: boolean;
  status: string;
  waitedForCapacity?: boolean;
}): 'failure' | 'success' | 'not_counted' {
  if (run.cancellationRequested || !COUNTED_TRIGGERS.has(run.triggerType))
    return 'not_counted';
  if (run.status === 'timed_out' && run.waitedForCapacity === true)
    return 'not_counted';
  if (FAILURE_STATUSES.has(run.status)) return 'failure';
  return run.status === 'succeeded' ? 'success' : 'not_counted';
}
