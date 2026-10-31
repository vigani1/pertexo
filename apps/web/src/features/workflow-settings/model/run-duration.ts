import type { WorkflowGraphContract } from '@pertexo/contracts';
import { formatDurationMs } from '@/lib/format/time';

/**
 * The longest duration a workflow may set (`WORKFLOW_EXECUTION_LIMITS` in
 * workflow-model, which the browser can't import; a test pins the two).
 */
export const RUN_DURATION_LIMIT_MS = 3_600_000;

const MINUTE_MS = 60_000;

/**
 * A workflow's own limit, or `undefined` for none: its runs get no deadline at
 * all, which is the only way a Wait longer than an hour can finish.
 */
export type RunDuration = number | undefined;

/** The limits offered, shortest first, after the choice of having none. */
export const RUN_DURATION_CHOICES: readonly number[] = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  RUN_DURATION_LIMIT_MS,
];

/** How long this graph lets a run take. */
export function maxRunDurationOf(
  graph: Pick<WorkflowGraphContract, 'settings'> | undefined,
): RunDuration {
  return graph?.settings.maxRunDurationMs;
}

/** The graph with a new maximum run duration and everything else kept. */
export function withMaxRunDuration(
  graph: WorkflowGraphContract,
  maxRunDurationMs: RunDuration,
): WorkflowGraphContract {
  const { maxRunDurationMs: _previous, ...settings } = graph.settings;
  return {
    ...graph,
    settings:
      maxRunDurationMs === undefined
        ? settings
        : { ...settings, maxRunDurationMs },
  };
}

/** "No limit", "1 minute", "15 minutes", "1 hour"; others as a compact duration. */
export function describeRunDuration(duration: RunDuration): string {
  if (duration === undefined) return 'No limit';
  if (duration === RUN_DURATION_LIMIT_MS) return '1 hour';
  if (duration % MINUTE_MS === 0) {
    const minutes = duration / MINUTE_MS;
    return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  }
  return formatDurationMs(duration);
}
