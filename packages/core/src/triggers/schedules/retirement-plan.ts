import type { ClaimRetirement } from './scanning/schedule-scanning.types.js';

/** A failed claim waits a minute; a deferred one at most five minutes. */
const RETIREMENT_RETRY_SECONDS = Object.freeze({ failed: 60, maximum: 300 });

export type RetirementPlan =
  | Readonly<{ kind: 'release' }>
  | Readonly<{
      kind: 'retire';
      retrySeconds: number;
      reason: string;
      health: 'unhealthy' | 'degraded';
    }>;

/**
 * How a claim the scanner gives back is stored: released as it was, or
 * retired with a retry delay, the reason and the schedule's health. A failed
 * scan only degrades the schedule; any other failure makes it unhealthy.
 */
export function planRetirement(retirement: ClaimRetirement): RetirementPlan {
  if (retirement.kind === 'release') return { kind: 'release' };
  const retrySeconds =
    retirement.kind === 'defer'
      ? retirement.retryAfterSeconds
      : RETIREMENT_RETRY_SECONDS.failed;
  if (
    !Number.isInteger(retrySeconds) ||
    retrySeconds < 1 ||
    retrySeconds > RETIREMENT_RETRY_SECONDS.maximum
  )
    throw new RangeError('Invalid schedule admission backoff');
  return {
    kind: 'retire',
    retrySeconds,
    reason:
      retirement.kind === 'defer'
        ? 'schedule.admission_throttled'
        : retirement.reason,
    health:
      retirement.kind === 'fail' && retirement.reason !== 'schedule.scan_failed'
        ? 'unhealthy'
        : 'degraded',
  };
}
