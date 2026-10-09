import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { RunTimelineRow } from '../timeline/run-timeline-model';

type GraphLevel = Readonly<Pick<WorkflowGraphContract, 'nodes' | 'edges'>>;

/**
 * For every step, the steps connected into it, on every level of the graph:
 * the workflow itself and each For each body inside it.
 */
export function upstreamSteps(
  graph: GraphLevel | undefined,
): ReadonlyMap<string, readonly string[]> {
  const upstream = new Map<string, string[]>();
  const visit = (level: GraphLevel) => {
    for (const edge of level.edges) {
      const sources = upstream.get(edge.target.nodeId) ?? [];
      if (!sources.includes(edge.source.nodeId))
        sources.push(edge.source.nodeId);
      upstream.set(edge.target.nodeId, sources);
    }
    for (const node of level.nodes)
      if (node.structured !== undefined) visit(node.structured.body);
  };
  if (graph !== undefined) visit(graph);
  return upstream;
}

// The engine keys a step run `version|step|b:…|i:…`; the tail names the
// branch and loop round it ran in.
function scopeOf(row: RunTimelineRow): string | undefined {
  return row.invocationKey?.split('|').slice(2).join('|');
}

/**
 * The runs of the steps that fed `row`, one per step connected into it: its
 * run in the same branch and loop round when there is one, else its only
 * run, else the last one to finish before `row` started.
 */
export function feedingRows(
  row: RunTimelineRow,
  rows: readonly RunTimelineRow[],
  upstream: ReadonlyMap<string, readonly string[]>,
): readonly RunTimelineRow[] {
  const startMs =
    row.startedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(row.startedAt);
  const scope = scopeOf(row);
  const fed: RunTimelineRow[] = [];
  for (const nodeId of upstream.get(row.nodeId) ?? []) {
    const runs = rows.filter(
      (candidate) =>
        candidate.nodeId === nodeId && candidate.nodeRunId !== undefined,
    );
    const finishedBefore = runs.filter(
      (candidate) =>
        candidate.completedAt !== undefined &&
        Date.parse(candidate.completedAt) <= startMs,
    );
    const choice =
      runs.find((candidate) => scopeOf(candidate) === scope) ??
      (runs.length === 1 ? runs[0] : (finishedBefore.at(-1) ?? runs.at(-1)));
    if (choice !== undefined) fed.push(choice);
  }
  return fed;
}
