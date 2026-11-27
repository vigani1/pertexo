import {
  usageTrendPeriodSchema,
  type UsageTrendPeriod,
} from '@pertexo/contracts';

export type UsageSearch = Readonly<{ period: UsageTrendPeriod }>;

/** The Usage page and Trends share one period; 30 days unless chosen. */
export function parseUsageSearch(
  value: Readonly<Record<string, unknown>>,
): UsageSearch {
  const result = usageTrendPeriodSchema.safeParse(value.period);
  return { period: result.success ? result.data : '30d' };
}
