import {
  computeCompatibilitySelectionFingerprint,
  parseRegistryRelease,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type NodeManifest,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  parseWorkflowGraphForPublish,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model/graph';
import {
  graphValidationIndex,
  nodePortKey,
  type GraphValidationIndex,
} from './executable-graph-validation-index.js';
import {
  isCoreMergeDefinition,
  isCoreParallelDefinition,
} from './core-definition-identities.js';
import { executableNodes } from './executable-graph.js';
import { parseBoundary } from './executable-boundary.js';
import {
  type CompiledWorkflowExecutableV2,
  type ExecutableRuntimePoliciesV1,
  BASELINE_RUNTIME_POLICIES_V1,
  type VerifiedWorkflowExecutableV2,
  type WorkflowExecutableGraphV2,
  type WorkflowExecutableNodeV2,
  type WorkflowExecutableV2,
  compareIdentity,
  compareOrdinal,
  digest,
  fail,
  freezeExecutable,
  globalPolicies,
  normalizeError,
  registerExecutableIdentity,
  sameIdentity,
  token,
  validateGlobals,
} from './executable-foundation.js';
import { sideEffectClass } from './executable-validation.js';

function uniqueDefinitions(
  nodes: readonly Pick<WorkflowExecutableNodeV2, 'definition'>[],
): readonly DefinitionIdentity[] {
  const unique = new Map<string, DefinitionIdentity>();
  for (const { definition } of nodes) unique.set(token(definition), definition);
  return [...unique.values()].sort(compareIdentity);
}

export function selectionFingerprint(
  release: RegistryRelease,
  nodes: readonly Pick<WorkflowExecutableNodeV2, 'definition'>[],
  policies: ExecutableRuntimePoliciesV1,
): string {
  const nodeSelectionFingerprint = computeCompatibilitySelectionFingerprint(
    release,
    uniqueDefinitions(nodes),
  );
  return `engine-select:v1:sha256:${digest(
    'pertexo.workflow-executable-selection.v1',
    {
      nodeSelectionFingerprint,
      globalPolicies: [...globalPolicies(policies)].sort(compareIdentity),
      configMigrations: [],
    },
  )}`;
}

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

function executableNode(
  node: WorkflowNode,
  release: RegistryRelease,
): WorkflowExecutableNodeV2 {
  const definition = definitionManifest(release, node.definition);
  const executor = executorManifest(release, definition.executor);
  if (
    (definition.lifecycle !== 'active' &&
      definition.lifecycle !== 'deprecated') ||
    executor.lifecycle !== 'active' ||
    !executor.definitions.some((value) =>
      sameIdentity(value, definition.definition),
    )
  )
    fail('node definition is not publishable');
  if (node.configVersion !== definition.configVersion)
    fail('node config version is incompatible');
  if (
    definition.executorAbi === undefined ||
    definition.executorAbi !== executor.abiVersion
  )
    fail('node executor ABI is incompatible');
  assertExpressionPolicies(node, definition.policyReferences);
  const executable: WorkflowExecutableNodeV2 = {
    id: node.id,
    definition: definition.definition,
    configVersion: node.configVersion,
    config: node.config,
    inputMappings: node.inputMappings,
    connectionRefs: node.connectionRefs,
    disabled: node.disabled ?? false,
    sideEffectClass: sideEffectClass(definition.retryClass),
    executor: definition.executor,
    executorAbi: executor.abiVersion,
    policyReferences: [...definition.policyReferences].sort(compareIdentity),
  };
  if (node.structured === undefined) return executable;
  return {
    ...executable,
    structured: {
      kind: 'for_each',
      maxIterations: node.structured.maxIterations,
      maxConcurrency: node.structured.maxConcurrency,
      body: {
        ...compileExecutableGraph(node.structured.body, release),
        inputPorts: node.structured.body.inputPorts,
        outputPorts: node.structured.body.outputPorts,
      },
    },
  };
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

function compileExecutableGraph(
  graph: WorkflowGraph,
  release: RegistryRelease,
): WorkflowExecutableGraphV2 {
  const index = graphValidationIndex(graph);
  assertGraphPorts(graph, release, index);
  assertBranchesDoNotReconverge(graph, index);
  return {
    settings: graph.settings,
    nodes: [...graph.nodes]
      .sort((left, right) => compareOrdinal(left.id, right.id))
      .map((node) => executableNode(node, release)),
    edges: canonicalEdges(graph),
  };
}

function buildBoundary(input: {
  readonly graph: unknown;
  readonly release: unknown;
}): CompiledWorkflowExecutableV2 {
  const release = parseRegistryRelease(input.release);
  validateGlobals(BASELINE_RUNTIME_POLICIES_V1, release);
  const graph = parseWorkflowGraphForPublish(input.graph, {
    schemaVersion: 1,
    definitions: release.definitions.map(({ definition }) => definition),
  });
  const executableGraph = compileExecutableGraph(graph, release);
  const envelope: WorkflowExecutableV2 = {
    schemaVersion: 2,
    sourceGraphSchemaVersion: 1,
    graph: executableGraph,
    runtimePolicies: BASELINE_RUNTIME_POLICIES_V1,
    configMigrations: [],
    compatibilitySelectionFingerprint: selectionFingerprint(
      release,
      executableNodes(executableGraph),
      BASELINE_RUNTIME_POLICIES_V1,
    ),
    compatibilityReleaseEpoch: release.epoch,
    compatibilityReleaseFingerprint: release.fingerprint,
  };
  const normalizedEnvelope = freezeExecutable(
    parseBoundary({ envelope, admissionRelease: release }),
  ) as VerifiedWorkflowExecutableV2;
  return registerExecutableIdentity(
    Object.freeze({
      envelope: normalizedEnvelope,
      checksum: computeWorkflowExecutableChecksumV2(normalizedEnvelope),
    }),
  );
}

/**
 * Compiles a graph that the publication use case has already validated against
 * each node's versioned config schema. This module owns executable identity;
 * config-schema execution remains at the injected registry seam.
 */
export function buildWorkflowExecutableV2(input: {
  readonly graph: unknown;
  readonly release: unknown;
}): CompiledWorkflowExecutableV2 {
  try {
    return buildBoundary(input);
  } catch (error) {
    normalizeError(error);
  }
}

function executableProjection(envelope: WorkflowExecutableV2): unknown {
  return {
    schemaVersion: envelope.schemaVersion,
    sourceGraphSchemaVersion: envelope.sourceGraphSchemaVersion,
    graph: envelope.graph,
    runtimePolicies: envelope.runtimePolicies,
    configMigrations: envelope.configMigrations,
    compatibilitySelectionFingerprint:
      envelope.compatibilitySelectionFingerprint,
  };
}

export function computeWorkflowExecutableChecksumV2(
  envelope: WorkflowExecutableV2,
): `wf:v2:sha256:${string}` {
  return `wf:v2:sha256:${digest(
    'pertexo.workflow-executable.v2',
    executableProjection(envelope),
  )}`;
}
