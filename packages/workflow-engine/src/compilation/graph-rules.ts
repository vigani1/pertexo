import { supportsExpressionMappings } from '@pertexo/workflow-model';
import type {
  DefinitionIdentity,
  ExecutorIdentity,
  NodeManifest,
  PolicyReference,
  NodeCatalog,
} from '@pertexo/node-sdk';
import {
  WORKFLOW_FAILURE_PORT,
  isWorkflowFailureSource,
  pendingTaskOutputPorts,
} from '@pertexo/workflow-model';
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model';
import {
  nodePortKey,
  type GraphValidationIndex,
} from './graph-validation-index.js';
import {
  isCoreMergeDefinition,
  isCoreParallelDefinition,
} from '../core-definition-identities.js';
import { compareOrdinal, fail, sameIdentity } from './foundation.js';

export function definitionManifest(
  catalog: NodeCatalog,
  definition: DefinitionIdentity,
): NodeManifest {
  const manifest = catalog.definitions.find((candidate) =>
    sameIdentity(candidate.definition, definition),
  );
  if (manifest === undefined) fail('node definition is unavailable');
  return manifest;
}

export function executorManifest(
  catalog: NodeCatalog,
  executor: ExecutorIdentity,
) {
  const manifest = catalog.executors.find((candidate) =>
    sameIdentity(candidate.executor, executor),
  );
  if (manifest === undefined) fail('node executor is unavailable');
  return manifest;
}

export function canonicalEdges(graph: WorkflowGraph): readonly WorkflowEdge[] {
  return [...graph.edges].sort((left, right) =>
    compareOrdinal(left.id, right.id),
  );
}

export function assertGraphPorts(
  graph: WorkflowGraph,
  catalog: NodeCatalog,
  index: GraphValidationIndex,
): void {
  const manifests = new Map(
    graph.nodes.map((node) => [
      node.id,
      definitionManifest(catalog, node.definition),
    ]),
  );
  for (const manifest of manifests.values())
    if (
      manifest.ports.inputs.includes(WORKFLOW_FAILURE_PORT) ||
      manifest.ports.outputs.includes(WORKFLOW_FAILURE_PORT)
    )
      fail('node catalog cannot declare the engine-owned failure port');
  for (const edge of graph.edges) {
    const source = manifests.get(edge.source.nodeId);
    const target = manifests.get(edge.target.nodeId);
    if (source === undefined || target === undefined)
      fail('workflow edge references an unavailable node');
    if (
      !source.ports.outputs.includes(edge.source.port) &&
      !(
        edge.source.port === WORKFLOW_FAILURE_PORT &&
        isWorkflowFailureSource(
          source.definition,
          index.nodesById.get(edge.source.nodeId)?.config,
        )
      )
    )
      fail('workflow edge source port is unavailable');
    const sourceNode = index.nodesById.get(edge.source.nodeId);
    if (
      sourceNode !== undefined &&
      !configuresOutputPort(sourceNode, edge, index)
    )
      fail('workflow edge source port is not configured');
    if (!target.ports.inputs.includes(edge.target.port))
      fail('workflow edge target port is unavailable');
  }
}

function configuresOutputPort(
  node: WorkflowGraph['nodes'][number],
  edge: WorkflowEdge,
  index: GraphValidationIndex,
): boolean {
  if (edge.source.port === WORKFLOW_FAILURE_PORT) return true;
  const taskPorts = pendingTaskOutputPorts(node);
  if (taskPorts !== undefined) return taskPorts.includes(edge.source.port);
  const control = index.controls.get(node.id);
  return (
    (control?.kind !== 'switch' && control?.kind !== 'parallel') ||
    structuredOutputPorts(node, index).includes(edge.source.port)
  );
}

/** Ports that open a branch scope: Condition, Switch and Parallel outputs. */
function structuredOutputPorts(
  node: WorkflowGraph['nodes'][number],
  index: GraphValidationIndex,
): readonly string[] {
  if (node.definition.key === 'core.condition' && node.definition.version === 1)
    return ['false', 'true'];
  const control = index.controls.get(node.id);
  if (control?.kind === 'switch')
    return [...control.config.cases.map(({ id }) => id), 'default'];
  if (control?.kind === 'parallel')
    return control.config.branches.map(({ id }) => id);
  return [];
}

export function assertBranchesDoNotReconverge(
  graph: WorkflowGraph,
  index: GraphValidationIndex,
): void {
  const descendants = (
    roots: readonly string[],
    boundaries: ReadonlySet<string> = new Set(),
  ): Set<string> => {
    const reached = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const nodeId = pending.pop();
      if (nodeId === undefined || reached.has(nodeId)) continue;
      if (boundaries.has(nodeId)) continue;
      reached.add(nodeId);
      pending.push(...(index.adjacency.get(nodeId) ?? []));
    }
    return reached;
  };

  for (const merge of graph.nodes.filter(({ definition }) =>
    isCoreMergeDefinition(definition),
  )) {
    assertMergeParallel(merge, index);
  }

  for (const node of graph.nodes) {
    const ports = structuredOutputPorts(node, index);
    if (ports.length === 0) continue;
    if (
      isCoreParallelDefinition(node.definition) &&
      ports.some(
        (port) =>
          (index.outgoingByNodePort.get(nodePortKey(node.id, port))?.length ??
            0) === 0,
      )
    )
      fail('every Parallel branch must have an outgoing edge');
    const pairedMerges = isCoreParallelDefinition(node.definition)
      ? (index.mergesByParallelNode.get(node.id) ?? [])
      : [];
    if (isCoreParallelDefinition(node.definition) && pairedMerges.length !== 1)
      fail('Parallel requires exactly one paired Merge');
    const pairedMerge = pairedMerges[0];
    if (pairedMerge !== undefined) {
      assertPairedMergeInputs(pairedMerge, ports, index);
    }
    const branchRoots = (port: string): string[] =>
      (index.outgoingByNodePort.get(nodePortKey(node.id, port)) ?? []).map(
        (edge) => edge.target.nodeId,
      );
    const boundaries = new Set(
      pairedMerge === undefined ? [] : [pairedMerge.id],
    );
    const reachedByPort = ports.map((port) =>
      descendants(branchRoots(port), boundaries),
    );
    if (
      pairedMerge !== undefined &&
      ports.some((port, portIndex) => {
        const incoming = index.incomingByNodePort.get(
          nodePortKey(pairedMerge.id, port),
        )?.[0];
        return (
          incoming === undefined ||
          (incoming.source.nodeId !== node.id &&
            !reachedByPort[portIndex]?.has(incoming.source.nodeId))
        );
      })
    )
      fail('each Parallel branch must reach its matching Merge input');
    for (let left = 0; left < reachedByPort.length; left += 1)
      for (let right = left + 1; right < reachedByPort.length; right += 1) {
        const leftReached = reachedByPort[left];
        const rightReached = reachedByPort[right];
        const branchesReconverge =
          leftReached !== undefined &&
          rightReached !== undefined &&
          [...leftReached].some((nodeId) => rightReached.has(nodeId));
        if (branchesReconverge)
          fail('branches cannot reconverge before Merge is available');
      }
  }
}

export function assertExpressionPolicies(
  node: Pick<WorkflowNode, 'inputMappings'>,
  policies: readonly PolicyReference[],
  capabilities: readonly string[] = [],
): void {
  for (const source of Object.values(node.inputMappings))
    if (
      source.kind === 'expression' &&
      !supportsExpressionMappings(policies, capabilities)
    )
      fail('expression policy is not available for the node definition');
}

function assertPairedMergeInputs(
  pairedMerge: WorkflowGraph['nodes'][number],
  ports: readonly string[],
  index: GraphValidationIndex,
): void {
  const incoming = index.incomingByNode.get(pairedMerge.id) ?? [];
  const mergeInputsMismatch =
    incoming.length !== ports.length ||
    ports.some(
      (port) =>
        (index.incomingByNodePort.get(nodePortKey(pairedMerge.id, port))
          ?.length ?? 0) !== 1,
    ) ||
    incoming.some(({ target }) => !ports.includes(target.port));
  if (mergeInputsMismatch)
    fail('paired Merge inputs must match every Parallel branch exactly once');
  const control = index.controls.get(pairedMerge.id);
  if (
    control?.kind === 'merge' &&
    control.config.policy.kind === 'count' &&
    control.config.policy.count > ports.length
  )
    fail('Merge count policy exceeds paired Parallel branches');
}

function assertMergeParallel(
  merge: WorkflowGraph['nodes'][number],
  index: GraphValidationIndex,
): void {
  const control = index.controls.get(merge.id);
  const parallel =
    control?.kind === 'merge'
      ? index.nodesById.get(control.config.parallelNodeId)
      : undefined;
  if (
    !isCoreParallelDefinition(parallel?.definition) ||
    parallel?.definition.version !== merge.definition.version
  )
    fail('Merge must reference a pinned Parallel node');
}
