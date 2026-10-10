import { parseNodeCatalog, type NodeCatalog } from '@pertexo/node-sdk';
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
  validateGlobals,
} from './foundation.js';
import { sideEffectClass } from './validation.js';

export { computeWorkflowExecutableChecksum } from './identity.js';

function executableNode(
  node: WorkflowNode,
  catalog: NodeCatalog,
): WorkflowExecutableNode {
  const definition = definitionManifest(catalog, node.definition);
  const executor = executorManifest(catalog, definition.executor);
  // Parsing the catalog already checked the definition-executor binding and ABI.
  if (node.configVersion !== definition.configVersion)
    fail('node config version is incompatible');
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
        ...compileExecutableGraph(node.structured.body, catalog),
        inputPorts: node.structured.body.inputPorts,
        outputPorts: node.structured.body.outputPorts,
      },
    },
  };
}

function compileExecutableGraph(
  graph: WorkflowGraph,
  catalog: NodeCatalog,
): WorkflowExecutableGraph {
  const index = graphValidationIndex(graph);
  assertGraphPorts(graph, catalog, index);
  assertBranchesDoNotReconverge(graph, index);
  return {
    settings: graph.settings,
    nodes: [...graph.nodes]
      .sort((left, right) => compareOrdinal(left.id, right.id))
      .map((node) => executableNode(node, catalog)),
    edges: canonicalEdges(graph),
  };
}

function buildBoundary(input: {
  readonly graph: unknown;
  readonly catalog: unknown;
}): CompiledWorkflowExecutable {
  const catalog = parseNodeCatalog(input.catalog);
  validateGlobals(BASELINE_RUNTIME_POLICIES, catalog);
  const graph = parseWorkflowGraphForPublish(input.graph, {
    definitions: catalog.definitions.map(({ definition }) => definition),
  });
  const executableGraph = compileExecutableGraph(graph, catalog);
  const envelope: WorkflowExecutable = {
    graph: executableGraph,
    runtimePolicies: BASELINE_RUNTIME_POLICIES,
  };
  const normalizedEnvelope = freezeExecutable(
    parseBoundary({ envelope, catalog }),
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
  readonly catalog: unknown;
}): CompiledWorkflowExecutable {
  try {
    return buildBoundary(input);
  } catch (error) {
    normalizeError(error);
  }
}
