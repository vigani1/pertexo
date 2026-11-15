import {
  usageTrendPeriodSchema,
  type UsageTrendPeriod,
} from '@pertexo/contracts';
import {
  workflowRunStatisticsWindowSchema,
  type WorkflowRunStatisticsWindow,
} from '@pertexo/contracts';

export type UsageSearch = Readonly<{ window: WorkflowRunStatisticsWindow }>;

export function parseUsageSearch(
  value: Readonly<Record<string, unknown>>,
): UsageSearch {
  const parsed = workflowRunStatisticsWindowSchema.safeParse(value.window);
  return { window: parsed.success ? parsed.data : '24h' };
}

export function parseUsageTrendsSearch(
  value: Readonly<Record<string, unknown>>,
): Readonly<{ period: UsageTrendPeriod }> {
  const result = usageTrendPeriodSchema.safeParse(value.period);
  return { period: result.success ? result.data : '30d' };
}
