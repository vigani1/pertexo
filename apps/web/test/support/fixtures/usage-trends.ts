import {
  workflowRunStatusSchema,
  type UsageTrendPeriod,
  type UsageTrendsResponse,
} from '@pertexo/contracts';
export function fixtureUsageTrends(
  period: UsageTrendPeriod = '30d',
  workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
): UsageTrendsResponse {
  const length = period === '30d' ? 30 : 90;
  const start = Date.UTC(2026, 9, 17) - (length - 1) * 86400000;
  const zero = Object.fromEntries(
    workflowRunStatusSchema.options.map((status) => [status, 0]),
  ) as UsageTrendsResponse['byStatus'];
  const byStatus = { ...zero, succeeded: 1, failed: 1, queued: 1 };
  const elapsed = { measuredRuns: 2, averageMs: 30000, slowestMs: 40000 };
  const asOf = '2026-10-17T12:00:00.000000Z';
  const from = new Date(start).toISOString().replace('.000Z', '.000000Z');
  const ranked = [
    { workflowId, workflowName: 'Order intake', runs: 3, failures: 1 },
  ];
  return {
    period,
    asOf,
    from,
    before: asOf,
    coverageFrom: from,
    total: 3,
    byStatus,
    elapsed,
    days: Array.from({ length }, (_, index) => ({
      day: new Date(start + index * 86400000).toISOString().slice(0, 10),
      total: index === length - 1 ? 3 : 0,
      byStatus: index === length - 1 ? byStatus : zero,
      elapsed:
        index === length - 1
          ? elapsed
          : { measuredRuns: 0, averageMs: null, slowestMs: null },
    })),
    busiest: ranked,
    mostFailures: ranked,
  };
}
