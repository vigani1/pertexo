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
 * don't count either way.
 */
export function streakOutcome(run: {
  triggerType: string;
  cancellationRequested: boolean;
  status: string;
}): 'failure' | 'success' | 'not_counted' {
  if (run.cancellationRequested || !COUNTED_TRIGGERS.has(run.triggerType))
    return 'not_counted';
  if (FAILURE_STATUSES.has(run.status)) return 'failure';
  return run.status === 'succeeded' ? 'success' : 'not_counted';
}
