import {
  workflowRunStatusSchema,
  type UsageTrendsResponse,
} from '@pertexo/contracts';

export const RECENT_USAGE_DAYS = 7;

export function usageInWindow(
  snapshot: UsageTrendsResponse,
  range: Readonly<{ from: string; to: string }> | undefined,
) {
  const days =
    range === undefined
      ? snapshot.days.slice(-RECENT_USAGE_DAYS)
      : snapshot.days.filter(({ day }) => day >= range.from && day <= range.to);
  const byStatus = { ...snapshot.byStatus };
  for (const status of workflowRunStatusSchema.options) {
    byStatus[status] = days.reduce(
      (total, day) => total + day.byStatus[status],
      0,
    );
  }
  return {
    days,
    byStatus,
    total: days.reduce((total, day) => total + day.total, 0),
  };
}
