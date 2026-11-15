import { EVENT_COORDINATION_LIMITS } from '@pertexo/workflow-model';

/**
 * When a held event is tried again: after a full workspace's retry hint, at
 * most five seconds, or a minute after a failed release.
 */
const RELEASE_RETRY = Object.freeze({
  capacityMaxSeconds: 5,
  failedMillis: 60_000,
});

type HeldEvent = Readonly<{
  deadline_at: Date;
  capacity_wait_started_at: Date | null;
}>;

/** A throttled event's next try: its window's due time, never past its deadlines. */
export function throttledReleaseAt(dueAt: number, event: HeldEvent): Date {
  return new Date(
    Math.min(
      dueAt,
      event.deadline_at.getTime(),
      event.capacity_wait_started_at === null
        ? Infinity
        : event.capacity_wait_started_at.getTime() +
            EVENT_COORDINATION_LIMITS.capacityWaitMillis,
    ),
  );
}

/**
 * A full workspace's next try: its retry hint, capped, never past the event's
 * deadline or the end of its capacity wait.
 */
export function capacityRetryAt(
  input: Readonly<{
    now: Date;
    retryAfterSeconds: number;
    event: HeldEvent;
    waitStartedAt: Date;
  }>,
): Date {
  return new Date(
    Math.min(
      input.now.getTime() +
        Math.min(RELEASE_RETRY.capacityMaxSeconds, input.retryAfterSeconds) *
          1_000,
      input.event.deadline_at.getTime(),
      input.waitStartedAt.getTime() +
        EVENT_COORDINATION_LIMITS.capacityWaitMillis,
    ),
  );
}

/** After a failed release, the event rests a minute, never past its deadline. */
export function failedReleaseRetryAt(now: Date, event: HeldEvent): Date {
  return new Date(
    Math.min(
      now.getTime() + RELEASE_RETRY.failedMillis,
      event.deadline_at.getTime(),
    ),
  );
}
