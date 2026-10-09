import { parseRegistryRelease, type RegistryRelease } from '@pertexo/node-sdk';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/server';
import { graphValidationIndex } from './graph-validation-index.js';
import { parseBoundary } from './boundary.js';
import {
  assertBranchesDoNotReconverge,
  assertExpressionPolicies,
  assertGraphPorts,
  canonicalEdges,
  definitionManifest,
  executorManifest,
} from './graph-rules.js';
import { computeWorkflowExecutableChecksum } from './identity.js';
import {
  type CompiledWorkflowExecutable,
  BASELINE_RUNTIME_POLICIES,
  type VerifiedWorkflowExecutable,
  type WorkflowExecutableGraph,
  type WorkflowExecutableNode,
  type WorkflowExecutable,
  compareIdentity,
  compareOrdinal,
  fail,
  freezeExecutable,
  normalizeError,
  registerExecutableIdentity,
  sameIdentity,
  validateGlobals,
} from './foundation.js';
import { sideEffectClass } from './validation.js';

export { computeWorkflowExecutableChecksum } from './identity.js';

function executableNode(
  node: WorkflowNode,
  release: RegistryRelease,
): WorkflowExecutableNode {
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
  const executable: WorkflowExecutableNode = {
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
): WorkflowExecutableGraph {
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
}): CompiledWorkflowExecutable {
  const release = parseRegistryRelease(input.release);
  validateGlobals(BASELINE_RUNTIME_POLICIES, release);
  const graph = parseWorkflowGraphForPublish(input.graph, {
    schemaVersion: 1,
    definitions: release.definitions.map(({ definition }) => definition),
  });
  const executableGraph = compileExecutableGraph(graph, release);
  const envelope: WorkflowExecutable = {
    schemaVersion: 2,
    sourceGraphSchemaVersion: 1,
    graph: executableGraph,
    runtimePolicies: BASELINE_RUNTIME_POLICIES,
  };
  const normalizedEnvelope = freezeExecutable(
    parseBoundary({ envelope, release }),
  ) as VerifiedWorkflowExecutable;
  return registerExecutableIdentity(
    Object.freeze({
      envelope: normalizedEnvelope,
      checksum: computeWorkflowExecutableChecksum(normalizedEnvelope),
    }),
  );
}

/**
 * Compiles a graph that the publication use case has already validated against
 * each node's versioned config schema. This module owns executable identity;
 * config-schema execution remains at the injected registry seam.
 */
export function buildWorkflowExecutable(input: {
  readonly graph: unknown;
  readonly release: unknown;
}): CompiledWorkflowExecutable {
  try {
    return buildBoundary(input);
  } catch (error) {
    normalizeError(error);
  }
}
