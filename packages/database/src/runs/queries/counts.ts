import type { RunStatus } from '@pertexo/workflow-engine';
export type RunStatusCounts = Record<RunStatus, number>;
export function emptyRunCounts(): RunStatusCounts {
  return {
    queued: 0,
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    timed_out: 0,
    outcome_unknown: 0,
  };
}
