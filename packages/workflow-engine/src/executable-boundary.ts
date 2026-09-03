import { parseRegistryRelease } from '@pertexo/node-sdk';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/graph';
import {
  allExecutableNodes,
  computeWorkflowExecutableChecksumV2,
  selectionFingerprint,
} from './executable-compilation.js';
import {
  type CompiledWorkflowExecutableV2,
  type VerifiedWorkflowExecutableV2,
  type WorkflowExecutableV2,
  fail,
  freezeExecutable,
  normalizeError,
  registerExecutableIdentity,
  validateGlobals,
} from './executable-foundation.js';
import {
  authoringGraph,
  readRawExecutableGraph,
  validateExecutableGraph,
} from './executable-graph-boundary.js';
import {
  assertSafeExecutableJson,
  exactKeys,
  normalizeBoundedEngineJson,
  parseGlobals,
  record,
} from './executable-validation.js';

export function parseBoundary(input: {
  readonly envelope: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}): WorkflowExecutableV2 {
  assertSafeExecutableJson(input.envelope);
  const normalizedEnvelope: unknown = normalizeBoundedEngineJson(
    input.envelope,
  );
  const envelope = record(normalizedEnvelope, 'executable envelope');
  exactKeys(envelope, [
    'schemaVersion',
    'sourceGraphSchemaVersion',
    'graph',
    'runtimePolicies',
    'configMigrations',
    'compatibilitySelectionFingerprint',
    'compatibilityReleaseEpoch',
    'compatibilityReleaseFingerprint',
  ]);
  if (envelope.schemaVersion !== 2 || envelope.sourceGraphSchemaVersion !== 1)
    fail('unsupported executable schema version');
  const admission = parseRegistryRelease(input.admissionRelease);
  const current = parseRegistryRelease(
    input.currentRelease ?? input.admissionRelease,
  );
  let alreadyAdmitted = false;
  if (input.execution !== undefined) {
    assertSafeExecutableJson(input.execution);
    const normalizedExecution: unknown = normalizeBoundedEngineJson(
      input.execution,
    );
    const execution = record(normalizedExecution, 'execution context');
    exactKeys(execution, ['alreadyAdmitted']);
    if (typeof execution.alreadyAdmitted !== 'boolean')
      fail('execution alreadyAdmitted must be boolean');
    alreadyAdmitted = execution.alreadyAdmitted;
  }
  if (
    envelope.compatibilityReleaseEpoch !== admission.epoch ||
    envelope.compatibilityReleaseFingerprint !== admission.fingerprint
  )
    fail('executable admission provenance does not match');
  const runtimePolicies = parseGlobals(envelope.runtimePolicies);
  validateGlobals(runtimePolicies, admission);
  validateGlobals(runtimePolicies, current);
  if (
    !Array.isArray(envelope.configMigrations) ||
    envelope.configMigrations.length
  )
    fail('Baseline runtime config migrations must be empty');
  const rawGraph = readRawExecutableGraph(envelope.graph, false);
  const graph = parseWorkflowGraphForPublish(authoringGraph(rawGraph), {
    schemaVersion: 1,
    definitions: admission.definitions.map(({ definition }) => definition),
  });
  const executableGraph = validateExecutableGraph(
    rawGraph,
    graph,
    admission,
    current,
    alreadyAdmitted,
  );
  const expectedSelection = selectionFingerprint(
    admission,
    allExecutableNodes(executableGraph),
    runtimePolicies,
  );
  if (envelope.compatibilitySelectionFingerprint !== expectedSelection)
    fail('compatibility selection fingerprint does not match');
  return {
    schemaVersion: 2,
    sourceGraphSchemaVersion: 1,
    graph: executableGraph,
    runtimePolicies,
    configMigrations: [],
    compatibilitySelectionFingerprint: expectedSelection,
    compatibilityReleaseEpoch: admission.epoch,
    compatibilityReleaseFingerprint: admission.fingerprint,
  };
}

export function parseWorkflowExecutableV2(input: {
  readonly envelope: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}): VerifiedWorkflowExecutableV2 {
  try {
    return freezeExecutable(
      parseBoundary(input),
    ) as VerifiedWorkflowExecutableV2;
  } catch (error) {
    normalizeError(error);
  }
}

export function verifyWorkflowExecutableV2(input: {
  readonly envelope: unknown;
  readonly checksum: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}): CompiledWorkflowExecutableV2 {
  const envelope = parseWorkflowExecutableV2(input);
  const checksum = computeWorkflowExecutableChecksumV2(envelope);
  if (input.checksum !== checksum)
    fail('workflow executable V2 checksum does not match');
  return registerExecutableIdentity(Object.freeze({ envelope, checksum }));
}
