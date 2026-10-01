import {
  workflowRunStatisticsWindowSchema,
  type WorkflowRunStatisticsWindow,
} from '@pertexo/contracts/schemas/workflow-runs';

export type UsageSearch = Readonly<{ window: WorkflowRunStatisticsWindow }>;

export function parseUsageSearch(
  value: Readonly<Record<string, unknown>>,
): UsageSearch {
  const parsed = workflowRunStatisticsWindowSchema.safeParse(value.window);
  return { window: parsed.success ? parsed.data : '24h' };
}
