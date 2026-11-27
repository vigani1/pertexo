/** How far ahead the Triggers tab lists schedule runs. */
export const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type UpcomingRun = Readonly<{
  triggerId: string;
  name: string;
  scheduledAt: string;
}>;

/**
 * The schedule runs due within the window from `now`, soonest first. Only
 * schedules know their runs ahead; webhooks and forms start when they arrive.
 */
export function upcomingRuns(
  schedules: readonly Readonly<{
    triggerId: string;
    name: string;
    times: readonly string[];
  }>[],
  now: number,
  windowMs = UPCOMING_WINDOW_MS,
): readonly UpcomingRun[] {
  return schedules
    .flatMap(({ triggerId, name, times }) =>
      times.map((scheduledAt) => ({ triggerId, name, scheduledAt })),
    )
    .filter(({ scheduledAt }) => {
      const at = Date.parse(scheduledAt);
      return at >= now && at <= now + windowMs;
    })
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}

/** Where a run sits along the window, from 0 (now) to 1 (its end). */
export function positionInWindow(
  scheduledAt: string,
  now: number,
  windowMs = UPCOMING_WINDOW_MS,
): number {
  return Math.min(1, Math.max(0, (Date.parse(scheduledAt) - now) / windowMs));
}
