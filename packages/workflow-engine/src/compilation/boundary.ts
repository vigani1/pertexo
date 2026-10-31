import { parseNodeCatalog, type NodeCatalog } from '@pertexo/node-sdk';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/server';
import { computeWorkflowExecutableChecksum } from './identity.js';
import {
  type CompiledWorkflowExecutable,
  type VerifiedWorkflowExecutable,
  type WorkflowExecutable,
  fail,
  freezeExecutable,
  readUntrusted,
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
  normalizeBoundedEngineValue,
  parseGlobals,
  record,
} from './validation.js';

export function parseBoundary(input: {
  readonly envelope: unknown;
  readonly catalog: unknown;
}): WorkflowExecutable {
  return readUntrusted(() => readBoundary(input)).executable;
}

function readBoundary(input: {
  readonly envelope: unknown;
  readonly catalog: unknown;
}): Readonly<{ executable: WorkflowExecutable; catalog: NodeCatalog }> {
  // Authored order survives, so a step's fields reach it as they were laid out.
  const normalizedEnvelope: unknown = normalizeBoundedEngineValue(
    input.envelope,
  );
  const envelope = record(normalizedEnvelope, 'executable envelope');
  exactKeys(envelope, ['graph', 'runtimePolicies']);
  const catalog = parseNodeCatalog(input.catalog);
  const runtimePolicies = parseGlobals(envelope.runtimePolicies);
  validateGlobals(runtimePolicies, catalog);
  const rawGraph = readRawExecutableGraph(envelope.graph, { body: false });
  const graph = parseWorkflowGraphForPublish(authoringGraph(rawGraph), {
    definitions: catalog.definitions.map(({ definition }) => definition),
  });
  return {
    executable: {
      graph: validateExecutableGraph(rawGraph, graph, catalog),
      runtimePolicies,
    },
    catalog,
  };
}

export function parseWorkflowExecutable(input: {
  readonly envelope: unknown;
  readonly catalog: unknown;
}): VerifiedWorkflowExecutable {
  return freezeExecutable(parseBoundary(input)) as VerifiedWorkflowExecutable;
}

/** Parses a stored executable against the served catalog and checks its checksum. */
export function verifyWorkflowExecutable(input: {
  readonly envelope: unknown;
  readonly checksum: unknown;
  readonly catalog: unknown;
}): CompiledWorkflowExecutable {
  const { executable, catalog } = readUntrusted(() => readBoundary(input));
  const envelope = freezeExecutable(executable) as VerifiedWorkflowExecutable;
  const checksum = computeWorkflowExecutableChecksum(envelope);
  if (input.checksum !== checksum)
    fail('workflow executable checksum does not match');
  return registerExecutableIdentity(
    Object.freeze({ envelope, checksum }),
    catalog,
  );
}
