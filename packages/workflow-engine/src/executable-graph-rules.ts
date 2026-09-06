import type {
  DefinitionIdentity,
  ExecutorIdentity,
  NodeManifest,
  PolicyReference,
  RegistryRelease,
} from '@pertexo/node-sdk';
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model/graph';
import {
  nodePortKey,
  type GraphValidationIndex,
} from './executable-graph-validation-index.js';
import {
  isCoreMergeDefinition,
  isCoreParallelDefinition,
} from './core-definition-identities.js';
import { compareOrdinal, fail, sameIdentity } from './executable-foundation.js';

export function definitionManifest(
  release: RegistryRelease,
  definition: DefinitionIdentity,
): NodeManifest {
  const manifest = release.definitions.find((candidate) =>
    sameIdentity(candidate.definition, definition),
  );
  if (manifest === undefined) fail('node definition is unavailable');
  return manifest;
}

export function executorManifest(
  release: RegistryRelease,
  executor: ExecutorIdentity,
) {
  const manifest = release.executors.find((candidate) =>
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
  release: RegistryRelease,
  index: GraphValidationIndex,
): void {
  const manifests = new Map(
    graph.nodes.map((node) => [
      node.id,
      definitionManifest(release, node.definition),
    ]),
  );
  for (const edge of graph.edges) {
    const source = manifests.get(edge.source.nodeId);
    const target = manifests.get(edge.target.nodeId);
    if (source === undefined || target === undefined)
      fail('workflow edge references an unavailable node');
    if (!source.ports.outputs.includes(edge.source.port))
      fail('workflow edge source port is unavailable');
    const sourceNode = index.nodesById.get(edge.source.nodeId);
    if (
      sourceNode !== undefined &&
      ((sourceNode.definition.key === 'core.switch' &&
        sourceNode.definition.version === 1) ||
        isCoreParallelDefinition(sourceNode.definition)) &&
      !configuredStructuredOutputPorts(sourceNode).includes(edge.source.port)
    )
      fail('workflow edge source port is not configured');
    if (!target.ports.inputs.includes(edge.target.port))
      fail('workflow edge target port is unavailable');
  }
}

function configuredBranchPorts(
  node: WorkflowGraph['nodes'][number],
): readonly string[] {
  if (node.definition.key === 'core.condition' && node.definition.version === 1)
    return ['false', 'true'];
  if (node.definition.key !== 'core.switch' || node.definition.version !== 1)
    return [];
  const cases = Reflect.get(node.config, 'cases') as unknown;
  if (!Array.isArray(cases)) return ['default'];
  return [
    ...cases.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item))
        return [];
      const id = Reflect.get(item, 'id') as unknown;
      return typeof id === 'string' ? [id] : [];
    }),
    'default',
  ];
}

function configuredParallelPorts(
  node: WorkflowGraph['nodes'][number],
): readonly string[] {
  if (!isCoreParallelDefinition(node.definition)) return [];
  const branches = Reflect.get(node.config, 'branches') as unknown;
  if (!Array.isArray(branches)) return [];
  return branches.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return [];
    const id = Reflect.get(item, 'id') as unknown;
    return typeof id === 'string' ? [id] : [];
  });
}

function configuredStructuredOutputPorts(
  node: WorkflowGraph['nodes'][number],
): readonly string[] {
  return [...configuredBranchPorts(node), ...configuredParallelPorts(node)];
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
    const parallelNodeId = Reflect.get(
      merge.config,
      'parallelNodeId',
    ) as unknown;
    const parallel =
      typeof parallelNodeId === 'string'
        ? index.nodesById.get(parallelNodeId)
        : undefined;
    if (
      !isCoreParallelDefinition(parallel?.definition) ||
      parallel?.definition.version !== merge.definition.version
    )
      fail('Merge must reference a pinned Parallel node');
  }

  for (const node of graph.nodes) {
    const ports = configuredStructuredOutputPorts(node);
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
      const incoming = index.incomingByNode.get(pairedMerge.id) ?? [];
      if (
        incoming.length !== ports.length ||
        ports.some(
          (port) =>
            (index.incomingByNodePort.get(nodePortKey(pairedMerge.id, port))
              ?.length ?? 0) !== 1,
        ) ||
        incoming.some(({ target }) => !ports.includes(target.port))
      )
        fail(
          'paired Merge inputs must match every Parallel branch exactly once',
        );
      const policy = Reflect.get(pairedMerge.config, 'policy') as unknown;
      if (
        typeof policy === 'object' &&
        policy !== null &&
        Reflect.get(policy, 'kind') === 'count' &&
        (typeof Reflect.get(policy, 'count') !== 'number' ||
          (Reflect.get(policy, 'count') as number) > ports.length)
      )
        fail('Merge count policy exceeds paired Parallel branches');
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
        if (
          leftReached !== undefined &&
          rightReached !== undefined &&
          [...leftReached].some((nodeId) => rightReached.has(nodeId))
        )
          fail('branches cannot reconverge before Merge is available');
      }
  }
}

export function assertExpressionPolicies(
  node: Pick<WorkflowNode, 'inputMappings'>,
  policies: readonly PolicyReference[],
): void {
  for (const source of Object.values(node.inputMappings))
    if (
      source.kind === 'expression' &&
      !policies.some(
        (policy) =>
          policy.key === 'jsonata.restricted' &&
          policy.version === source.policyVersion,
      )
    )
      fail('expression policy is not pinned by the node definition');
}
