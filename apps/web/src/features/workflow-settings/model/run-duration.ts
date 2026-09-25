import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { formatDurationMs } from '@/lib/format-time';

/**
 * The longest a run may take (`WORKFLOW_EXECUTION_LIMITS_V1` in
 * workflow-model, which the browser can't import; a test pins the two). A
 * workflow without its own setting gets this limit.
 */
export const RUN_DURATION_LIMIT_MS = 3_600_000;

const MINUTE_MS = 60_000;

/** The durations offered, shortest first, ending at the limit. */
export const RUN_DURATION_CHOICES: readonly number[] = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  RUN_DURATION_LIMIT_MS,
];

/** How long this graph lets a run take, its own setting or the limit. */
export function maxRunDurationOf(
  graph: Pick<WorkflowGraphContract, 'settings'> | undefined,
): number {
  return graph?.settings.maxRunDurationMs ?? RUN_DURATION_LIMIT_MS;
}

/** The graph with a new maximum run duration and everything else kept. */
export function withMaxRunDuration(
  graph: WorkflowGraphContract,
  maxRunDurationMs: number,
): WorkflowGraphContract {
  return { ...graph, settings: { ...graph.settings, maxRunDurationMs } };
}

/** "1 minute", "15 minutes", "1 hour"; other values as a compact duration. */
export function describeRunDuration(durationMs: number): string {
  if (durationMs === RUN_DURATION_LIMIT_MS) return '1 hour';
  if (durationMs % MINUTE_MS === 0) {
    const minutes = durationMs / MINUTE_MS;
    return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  }
  return formatDurationMs(durationMs);
}
