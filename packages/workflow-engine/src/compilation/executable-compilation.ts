import { parseRegistryRelease, type RegistryRelease } from '@pertexo/node-sdk';
import {
  parseWorkflowGraphForPublish,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model/graph';
import { graphValidationIndex } from './executable-graph-validation-index.js';
import { executableNodes } from './executable-graph.js';
import { parseBoundary } from './executable-boundary.js';
import {
  assertBranchesDoNotReconverge,
  assertExpressionPolicies,
  assertGraphPorts,
  canonicalEdges,
  definitionManifest,
  executorManifest,
} from './executable-graph-rules.js';
import {
  computeWorkflowExecutableChecksumV2,
  selectionFingerprint,
} from './executable-identity.js';
import {
  type CompiledWorkflowExecutableV2,
  BASELINE_RUNTIME_POLICIES_V1,
  type VerifiedWorkflowExecutableV2,
  type WorkflowExecutableGraphV2,
  type WorkflowExecutableNodeV2,
  type WorkflowExecutableV2,
  compareIdentity,
  compareOrdinal,
  fail,
  freezeExecutable,
  normalizeError,
  registerExecutableIdentity,
  sameIdentity,
  validateGlobals,
} from './executable-foundation.js';
import { sideEffectClass } from './executable-validation.js';

export { computeWorkflowExecutableChecksumV2 } from './executable-identity.js';

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
