import {
  isCoreMergeDefinition,
  isCoreParallelDefinition,
} from '../../core-definition-identities.js';
import type { SchedulerState } from './readiness.js';

type SchedulerNode = SchedulerState['nodes'][number];

export interface SchedulerGraphIndexes {
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  readonly mergeNodeIds: ReadonlySet<string>;
  readonly pairedMergeByParallel: ReadonlyMap<string, string>;
  readonly pairedParallelByMerge: ReadonlyMap<string, string>;
}

function configuredPairedParallelId(node: SchedulerNode): string | undefined {
  if (!isCoreMergeDefinition(node.definition)) return undefined;
  const parallelNodeId = node.config?.parallelNodeId;
  return typeof parallelNodeId === 'string' ? parallelNodeId : undefined;
}

export function indexSchedulerGraph(
  graph: SchedulerState,
  nodeById: ReadonlyMap<string, SchedulerNode>,
): SchedulerGraphIndexes {
  const predecessors = new Map<string, string[]>();
  const adjacency = new Map<string, string[]>();
  const mergeNodeIds = new Set<string>();
  const pairedMergeByParallel = new Map<string, string>();
  const pairedParallelByMerge = new Map<string, string>();
  graph.nodes.forEach((node) => {
    const { id } = node;
    predecessors.set(id, []);
    adjacency.set(id, []);
    if (!isCoreMergeDefinition(node.definition)) return;
    mergeNodeIds.add(id);
    const parallelNodeId = configuredPairedParallelId(node);
    const parallel =
      parallelNodeId === undefined ? undefined : nodeById.get(parallelNodeId);
    if (
      parallel !== undefined &&
      isCoreParallelDefinition(parallel.definition)
    ) {
      pairedMergeByParallel.set(parallel.id, id);
      pairedParallelByMerge.set(id, parallel.id);
    }
  });
  graph.edges.forEach(({ source, target }) => {
    predecessors.get(target.nodeId)?.push(source.nodeId);
    adjacency.get(source.nodeId)?.push(target.nodeId);
  });
  return {
    predecessors,
    adjacency,
    mergeNodeIds,
    pairedMergeByParallel,
    pairedParallelByMerge,
  };
}

/** Steps reachable from `roots`, not crossing or including `boundaries`. */
export function descendants(
  roots: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  boundaries: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || reached.has(nodeId)) continue;
    if (boundaries.has(nodeId)) continue;
    reached.add(nodeId);
    pending.push(...(adjacency.get(nodeId) ?? []));
  }
  return reached;
}
