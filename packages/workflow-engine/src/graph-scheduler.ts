import { invocationKey } from './scheduling.js';
import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import type {
  BranchScopePart,
  BranchSelection,
  InvocationState,
} from './types.js';
import type { SideEffectClass } from './types.js';

/** Private execution projection derived only from a verified executable. */
export interface SchedulerState {
  readonly deriveReadiness: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly definition?: { readonly key: string; readonly version: number };
    readonly disabled?: boolean;
    readonly sideEffectClass: SideEffectClass;
  }[];
  readonly edges: readonly {
    readonly source: { readonly nodeId: string; readonly port: string };
    readonly target: { readonly nodeId: string; readonly port: string };
  }[];
}

export interface ReadyNodeDecision {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly disposition: 'ready' | 'skipped';
  readonly branchPath?: readonly BranchScopePart[];
}

function descendants(
  roots: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || reached.has(nodeId)) continue;
    reached.add(nodeId);
    pending.push(...(adjacency.get(nodeId) ?? []));
  }
  return reached;
}

export function deriveReadyNodes(input: {
  readonly graph: SchedulerState;
  readonly workflowVersionId: string;
  readonly invocations: readonly InvocationState[];
  readonly branchSelections?: readonly BranchSelection[];
}): readonly ReadyNodeDecision[] {
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const invocationByKey = new Map(
    input.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const selection of input.branchSelections ?? []) {
    const node = nodeById.get(selection.nodeId);
    const invocation = invocationByKey.get(selection.invocationKey);
    if (
      node?.definition?.key !== 'core.condition' ||
      node.definition.version !== 1 ||
      invocation?.nodeId !== selection.nodeId ||
      invocation.status !== 'succeeded' ||
      invocation.output === undefined ||
      (selection.selectedOutputPort !== 'true' &&
        selection.selectedOutputPort !== 'false')
    )
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        'branch selection disagrees with the pinned Condition contract',
      );
  }
  const invocationByNode = new Map<string, InvocationState>();
  for (const invocation of input.invocations) {
    const existing = invocationByNode.get(invocation.nodeId);
    const isRoot =
      invocation.invocationKey ===
      invocationKey({
        workflowVersionId: input.workflowVersionId,
        nodeId: invocation.nodeId,
      });
    if (existing === undefined || isRoot)
      invocationByNode.set(invocation.nodeId, invocation);
  }
  const predecessors = new Map<string, string[]>();
  const adjacency = new Map<string, string[]>();
  for (const node of input.graph.nodes) predecessors.set(node.id, []);
  for (const node of input.graph.nodes) adjacency.set(node.id, []);
  for (const edge of input.graph.edges) {
    predecessors.get(edge.target.nodeId)?.push(edge.source.nodeId);
    adjacency.get(edge.source.nodeId)?.push(edge.target.nodeId);
  }
  const blocked = new Set<string>();
  const skipped = new Set<string>();
  const branchPathByNode = new Map<string, readonly BranchScopePart[]>();
  for (const condition of input.graph.nodes.filter(
    ({ definition }) =>
      definition?.key === 'core.condition' && definition.version === 1,
  )) {
    const invocation = invocationByNode.get(condition.id);
    if (invocation?.status !== 'succeeded') continue;
    const selection = input.branchSelections?.find(
      (candidate) =>
        candidate.invocationKey === invocation.invocationKey &&
        candidate.nodeId === condition.id,
    );
    const outgoing = input.graph.edges.filter(
      (edge) => edge.source.nodeId === condition.id,
    );
    if (selection === undefined) {
      for (const nodeId of descendants(
        outgoing.map(({ target }) => target.nodeId),
        adjacency,
      ))
        blocked.add(nodeId);
      continue;
    }
    for (const port of ['false', 'true'] as const) {
      const branchPath = [
        ...(invocation.branchPath ?? []),
        { nodeId: condition.id, outputPort: port },
      ];
      const branchDescendants = descendants(
        outgoing
          .filter((edge) => edge.source.port === port)
          .map(({ target }) => target.nodeId),
        adjacency,
      );
      for (const nodeId of branchDescendants) {
        const existing = branchPathByNode.get(nodeId);
        if (existing === undefined || branchPath.length > existing.length)
          branchPathByNode.set(nodeId, branchPath);
        if (port !== selection.selectedOutputPort) skipped.add(nodeId);
      }
    }
  }
  return [...input.graph.nodes]
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .filter((node) => {
      if (invocationByNode.has(node.id)) return false;
      if (skipped.has(node.id)) return true;
      if (blocked.has(node.id)) return false;
      return (predecessors.get(node.id) ?? []).every((predecessor) => {
        const state = invocationByNode.get(predecessor)?.status;
        return state === 'succeeded' || state === 'skipped';
      });
    })
    .map((node) => {
      const branchPath = branchPathByNode.get(node.id);
      return {
        invocationKey: invocationKey({
          workflowVersionId: input.workflowVersionId,
          nodeId: node.id,
          ...(branchPath === undefined
            ? {}
            : {
                branchPath: branchPath.map(
                  ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
                ),
              }),
        }),
        nodeId: node.id,
        disposition:
          skipped.has(node.id) || node.disabled === true ? 'skipped' : 'ready',
        ...(branchPath === undefined ? {} : { branchPath }),
      } as const;
    });
}
