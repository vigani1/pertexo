import {
  isCoreMergeDefinition,
  isCoreParallelDefinition,
} from './core-definition-identities.js';
import type { SchedulerState } from './graph-scheduler.js';

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
  if (
    typeof node.config !== 'object' ||
    node.config === null ||
    Array.isArray(node.config)
  )
    return undefined;
  const parallelNodeId = Reflect.get(node.config, 'parallelNodeId') as unknown;
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
