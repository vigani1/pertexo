import type {
  WorkflowNodeRunSummary,
  WorkflowRunSummary,
} from '@pertexo/contracts';
import { formatDurationMs } from '@/lib/format/time';
import { formatCount } from '@/lib/format/count';
import type { GraphLevel } from '../graph/scopes';

type NodeRun = WorkflowNodeRunSummary;

/**
 * What a step did in the workflow's last run, in the few words the canvas
 * writes under it: a duration, an error code and its tries, or that the
 * run never reached it.
 */
export type StepRunResult =
  | Readonly<{ kind: 'ran'; status: NodeRun['status']; detail: string | null }>
  | Readonly<{
      kind: 'failed';
      status: Extract<NodeRun['status'], 'failed' | 'timed_out'>;
      code: string | null;
      tries: string | null;
    }>
  | Readonly<{ kind: 'not-taken' }>;

/** The last run as the canvas draws it: a result per step and live links. */
export type LastRunOverlay = Readonly<{
  run: WorkflowRunSummary;
  results: ReadonlyMap<string, StepRunResult>;
  /** Steps working right now, which breathe. */
  runningNodeIds: ReadonlySet<string>;
  /** Links from a finished step into one that is working: they flow. */
  liveEdgeIds: ReadonlySet<string>;
}>;

const WORKING: ReadonlySet<NodeRun['status']> = new Set(['running', 'ready']);

/**
 * Reads a run's steps onto the workflow's own steps. A step that ran more
 * than once (a retry from a step, a loop) shows its latest invocation. Once
 * the run is over, a step it never reached says so; while it runs, those
 * steps simply wait.
 */
export function lastRunOverlay(
  level: GraphLevel,
  run: WorkflowRunSummary,
  nodeRuns: readonly NodeRun[],
  finished: boolean,
): LastRunOverlay {
  const latest = new Map<string, NodeRun>();
  for (const nodeRun of nodeRuns) {
    const known = latest.get(nodeRun.nodeId);
    if (known === undefined || startOf(nodeRun) >= startOf(known))
      latest.set(nodeRun.nodeId, nodeRun);
  }
  const results = new Map<string, StepRunResult>();
  for (const node of level.nodes) {
    const nodeRun = latest.get(node.id);
    if (nodeRun !== undefined) results.set(node.id, stepResult(nodeRun));
    else if (finished) results.set(node.id, { kind: 'not-taken' });
  }
  const runningNodeIds = new Set(
    [...latest.values()]
      .filter((nodeRun) => WORKING.has(nodeRun.status))
      .map((nodeRun) => nodeRun.nodeId),
  );
  const liveEdgeIds = new Set(
    level.edges
      .filter(
        (edge) =>
          runningNodeIds.has(edge.target.nodeId) &&
          latest.get(edge.source.nodeId)?.status === 'succeeded',
      )
      .map((edge) => edge.id),
  );
  return { run, results, runningNodeIds, liveEdgeIds };
}

function stepResult(nodeRun: NodeRun): StepRunResult {
  const tries =
    nodeRun.currentAttemptNumber > 1
      ? formatCount(nodeRun.currentAttemptNumber, 'try', 'tries')
      : null;
  if (nodeRun.status === 'failed' || nodeRun.status === 'timed_out')
    return {
      kind: 'failed',
      status: nodeRun.status,
      code: nodeRun.safeErrorCode ?? null,
      tries,
    };
  const took =
    nodeRun.startedAt === null || nodeRun.completedAt === null
      ? null
      : formatDurationMs(
          Date.parse(nodeRun.completedAt) - Date.parse(nodeRun.startedAt),
        );
  return { kind: 'ran', status: nodeRun.status, detail: took };
}

function startOf(nodeRun: NodeRun): number {
  return nodeRun.startedAt === null ? 0 : Date.parse(nodeRun.startedAt);
}
