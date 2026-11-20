import {
  RUN_STATUS,
  UNSUCCESSFUL_RUN_STATUSES,
} from '../execution/run-status.js';

const unsuccessful: ReadonlySet<string> = new Set(UNSUCCESSFUL_RUN_STATUSES);
const COUNTED_STREAK_TRIGGERS: ReadonlySet<string> = new Set([
  'schedule',
  'webhook',
  'form',
  'polling',
]);

/**
 * What a finished run means for its workflow's failure streak (ADR 056). A success
 * resets it. A canceled run, and runs started by hand, through the API or as replays,
 * don't count either way, and nor does a run whose time ran out while it queued for
 * capacity: overload is the platform's problem, and it shouldn't switch off a trigger.
 * Runs record it as they end; triggers fold it into the streak and the pause.
 */
export function failureStreakOutcome(run: {
  triggerType: string;
  cancellationRequested: boolean;
  status: string;
  waitedForCapacity?: boolean;
}): 'failure' | 'success' | 'not_counted' {
  if (
    run.cancellationRequested ||
    !COUNTED_STREAK_TRIGGERS.has(run.triggerType)
  )
    return 'not_counted';
  if (run.status === RUN_STATUS.timedOut && run.waitedForCapacity === true)
    return 'not_counted';
  if (unsuccessful.has(run.status)) return 'failure';
  return run.status === RUN_STATUS.succeeded ? 'success' : 'not_counted';
}
