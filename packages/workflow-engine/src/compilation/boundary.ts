import { parseNodeCatalog } from '@pertexo/node-sdk';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/server';
import { computeWorkflowExecutableChecksum } from './identity.js';
import {
  type CompiledWorkflowExecutable,
  type VerifiedWorkflowExecutable,
  type WorkflowExecutable,
  fail,
  freezeExecutable,
  normalizeError,
  registerExecutableIdentity,
  validateGlobals,
} from './foundation.js';
import {
  authoringGraph,
  readRawExecutableGraph,
  validateExecutableGraph,
} from './graph-boundary.js';
import {
  exactKeys,
  normalizeBoundedEngineJson,
  parseGlobals,
  record,
} from './validation.js';

export function parseBoundary(input: {
  readonly envelope: unknown;
  readonly catalog: unknown;
}): WorkflowExecutable {
  const normalizedEnvelope: unknown = normalizeBoundedEngineJson(
    input.envelope,
  );
  const envelope = record(normalizedEnvelope, 'executable envelope');
  exactKeys(envelope, [
    'schemaVersion',
    'sourceGraphSchemaVersion',
    'graph',
    'runtimePolicies',
  ]);
  if (envelope.schemaVersion !== 2 || envelope.sourceGraphSchemaVersion !== 1)
    fail('unsupported executable schema version');
  const catalog = parseNodeCatalog(input.catalog);
  const runtimePolicies = parseGlobals(envelope.runtimePolicies);
  validateGlobals(runtimePolicies, catalog);
  const rawGraph = readRawExecutableGraph(envelope.graph, false);
  const graph = parseWorkflowGraphForPublish(authoringGraph(rawGraph), {
    schemaVersion: 1,
    definitions: catalog.definitions.map(({ definition }) => definition),
  });
  return {
    schemaVersion: 2,
    sourceGraphSchemaVersion: 1,
    graph: validateExecutableGraph(rawGraph, graph, catalog),
    runtimePolicies,
  };
}

export function parseWorkflowExecutable(input: {
  readonly envelope: unknown;
  readonly catalog: unknown;
}): VerifiedWorkflowExecutable {
  try {
    return freezeExecutable(parseBoundary(input)) as VerifiedWorkflowExecutable;
  } catch (error) {
    normalizeError(error);
  }
}

/** Parses a stored executable against the served catalog and checks its checksum. */
export function verifyWorkflowExecutable(input: {
  readonly envelope: unknown;
  readonly checksum: unknown;
  readonly catalog: unknown;
}): CompiledWorkflowExecutable {
  const envelope = parseWorkflowExecutable(input);
  const checksum = computeWorkflowExecutableChecksum(envelope);
  if (input.checksum !== checksum)
    fail('workflow executable checksum does not match');
  return registerExecutableIdentity(Object.freeze({ envelope, checksum }));
}
