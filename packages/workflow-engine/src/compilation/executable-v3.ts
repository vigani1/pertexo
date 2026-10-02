import {
  computeCompatibilitySelectionFingerprint,
  createRegistryRelease,
  parseRegistryRelease,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/graph';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallFamilyPolicySchemaV1,
  type WorkflowCallFamilyPolicyV1,
} from '@pertexo/workflow-model/workflow-call-contract';
import {
  validateWorkflowCallableGraphV2,
  workflowCallStructuralProjectionV1,
} from '@pertexo/workflow-model/workflow-call-closure';
import { composeExecutableCompatibilityRelease } from './executable-compatibility.js';
import { compileExecutableGraph } from './executable-compilation.js';
import {
  compareIdentity,
  digest,
  fail,
  freezeExecutable,
  globalPolicies,
  normalizeError,
  sameIdentity,
  token,
  type ExecutableRuntimePoliciesV1,
  type WorkflowExecutableGraphV2,
} from './executable-foundation.js';
import {
  authoringGraph,
  readRawExecutableGraph,
  validateExecutableGraph,
} from './executable-graph-boundary.js';
import { executableNodes } from './executable-graph.js';
import {
  exactKeys,
  normalizeBoundedEngineJson,
  parseGlobals,
  record,
} from './executable-validation.js';

export const WORKFLOW_CALL_RUNTIME_POLICIES_V1 = Object.freeze({
  scheduler: Object.freeze({ key: 'engine.scheduler', version: 2 }),
  checkpoint: Object.freeze({ key: 'engine.checkpoint', version: 2 }),
  retry: Object.freeze({ key: 'engine.retry', version: 1 }),
  timeout: Object.freeze({ key: 'engine.timeout', version: 2 }),
  cancellation: Object.freeze({ key: 'engine.cancellation', version: 2 }),
});

export interface WorkflowExecutableGraphV3 extends WorkflowExecutableGraphV2 {
  readonly callable?: WorkflowCallableDeclarationV1 | undefined;
}

export interface WorkflowExecutableV3 {
  readonly schemaVersion: 3;
  readonly sourceGraphSchemaVersion: 2;
  readonly graph: WorkflowExecutableGraphV3;
  readonly familyPolicy: WorkflowCallFamilyPolicyV1;
  readonly runtimePolicies: ExecutableRuntimePoliciesV1;
  readonly configMigrations: readonly [];
  readonly compatibilitySelectionFingerprint: string;
  readonly compatibilityReleaseEpoch: number;
  readonly compatibilityReleaseFingerprint: string;
}

declare const verifiedExecutableV3: unique symbol;
export type VerifiedWorkflowExecutableV3 = WorkflowExecutableV3 & {
  readonly [verifiedExecutableV3]: true;
};
export interface CompiledWorkflowExecutableV3 {
  readonly envelope: VerifiedWorkflowExecutableV3;
  readonly checksum: `wf:v3:sha256:${string}`;
}

const authenticIdentities = new WeakSet<object>();

export function assertAuthenticExecutableIdentityV3(
  value: CompiledWorkflowExecutableV3,
): void {
  if (!authenticIdentities.has(value))
    fail('workflow executable V3 identity was not verified in this process');
}

function authenticate(
  envelope: VerifiedWorkflowExecutableV3,
): CompiledWorkflowExecutableV3 {
  const compiled = Object.freeze({
    envelope,
    checksum: computeWorkflowExecutableChecksumV3(envelope),
  });
  authenticIdentities.add(compiled);
  return compiled;
}

/** Additive artifact support: baseline identities remain available unchanged. */
export function composeExecutableCompatibilityReleaseV3(
  nodeReleaseInput: unknown,
): RegistryRelease {
  try {
    const baseline = composeExecutableCompatibilityRelease(nodeReleaseInput);
    const existing = new Set(baseline.policies.map(token));
    return createRegistryRelease({
      epoch: baseline.epoch,
      definitions: baseline.definitions,
      executors: baseline.executors,
      policies: [
        ...baseline.policies,
        ...globalPolicies(WORKFLOW_CALL_RUNTIME_POLICIES_V1).filter(
          (policy) => !existing.has(token(policy)),
        ),
      ],
    });
  } catch (error) {
    normalizeError(error);
  }
}

function validateCallGlobals(
  policies: ExecutableRuntimePoliciesV1,
  release: RegistryRelease,
): void {
  const selected = globalPolicies(policies);
  const expected = globalPolicies(WORKFLOW_CALL_RUNTIME_POLICIES_V1);
  if (
    !selected.every((policy, index) => {
      const expectedPolicy = expected[index];
      return (
        expectedPolicy !== undefined && sameIdentity(policy, expectedPolicy)
      );
    }) ||
    new Set(selected.map(token)).size !== selected.length
  )
    fail('runtime policy selection is not workflow call policy v1');
  const available = new Set(release.policies.map(token));
  if (!selected.every((policy) => available.has(token(policy))))
    fail('compatibility release is missing a workflow call runtime policy');
}

function selectionFingerprintV3(
  release: RegistryRelease,
  graph: WorkflowExecutableGraphV3,
  policies: ExecutableRuntimePoliciesV1,
): string {
  const definitions = new Map(
    executableNodes(graph).map(({ definition }) => [
      token(definition),
      definition,
    ]),
  );
  return `engine-select:v3:sha256:${digest(
    'pertexo.workflow-executable-selection.v3',
    {
      nodeSelectionFingerprint: computeCompatibilitySelectionFingerprint(
        release,
        [...definitions.values()].sort(compareIdentity),
      ),
      globalPolicies: [...globalPolicies(policies)].sort(compareIdentity),
      callablePolicies: callablePolicies(graph),
      configMigrations: [],
    },
  )}`;
}

function callablePolicies(
  graph: Pick<WorkflowExecutableGraphV3, 'callable'>,
): readonly PolicyReference[] {
  return graph.callable?.resultSelector.kind === 'expression'
    ? [{ key: 'jsonata.restricted', version: 1 }]
    : [];
}

function validateCallablePolicies(
  graph: Pick<WorkflowExecutableGraphV3, 'callable'>,
  release: RegistryRelease,
): void {
  const available = new Set(release.policies.map(token));
  if (!callablePolicies(graph).every((policy) => available.has(token(policy))))
    fail('compatibility release is missing a callable result policy');
}

/** All executable behavior is hashed; release provenance remains outside identity. */
export function computeWorkflowExecutableChecksumV3(
  envelope: WorkflowExecutableV3,
): `wf:v3:sha256:${string}` {
  return `wf:v3:sha256:${digest('pertexo.workflow-executable.v3', {
    schemaVersion: envelope.schemaVersion,
    sourceGraphSchemaVersion: envelope.sourceGraphSchemaVersion,
    graph: envelope.graph,
    familyPolicy: envelope.familyPolicy,
    runtimePolicies: envelope.runtimePolicies,
    configMigrations: envelope.configMigrations,
    compatibilitySelectionFingerprint:
      envelope.compatibilitySelectionFingerprint,
  })}`;
}

interface ParseInput {
  readonly envelope: unknown;
  readonly admissionRelease: unknown;
  readonly currentRelease?: unknown;
  readonly execution?: { readonly alreadyAdmitted: boolean };
}

function alreadyAdmitted(input: ParseInput['execution']): boolean {
  if (input === undefined) return false;
  const execution = record(
    normalizeBoundedEngineJson(input),
    'execution context',
  );
  exactKeys(execution, ['alreadyAdmitted']);
  if (typeof execution.alreadyAdmitted !== 'boolean')
    fail('execution alreadyAdmitted must be boolean');
  return execution.alreadyAdmitted;
}

function parseBoundaryV3(input: ParseInput): WorkflowExecutableV3 {
  const envelope = record(
    normalizeBoundedEngineJson(input.envelope),
    'executable envelope',
  );
  exactKeys(envelope, [
    'schemaVersion',
    'sourceGraphSchemaVersion',
    'graph',
    'familyPolicy',
    'runtimePolicies',
    'configMigrations',
    'compatibilitySelectionFingerprint',
    'compatibilityReleaseEpoch',
    'compatibilityReleaseFingerprint',
  ]);
  if (envelope.schemaVersion !== 3 || envelope.sourceGraphSchemaVersion !== 2)
    fail('unsupported executable schema version');
  const admission = parseRegistryRelease(input.admissionRelease);
  const current = parseRegistryRelease(
    input.currentRelease ?? input.admissionRelease,
  );
  if (
    envelope.compatibilityReleaseEpoch !== admission.epoch ||
    envelope.compatibilityReleaseFingerprint !== admission.fingerprint
  )
    fail('executable admission provenance does not match');
  const runtimePolicies = parseGlobals(envelope.runtimePolicies);
  validateCallGlobals(runtimePolicies, admission);
  validateCallGlobals(runtimePolicies, current);
  const familyPolicy = workflowCallFamilyPolicySchemaV1.parse(
    envelope.familyPolicy,
  );
  if (
    !Array.isArray(envelope.configMigrations) ||
    envelope.configMigrations.length
  )
    fail('Workflow call runtime config migrations must be empty');
  const raw = record(envelope.graph, 'executable graph');
  exactKeys(raw, ['settings', 'nodes', 'edges'], ['callable']);
  const rawGraph = readRawExecutableGraph(
    { settings: raw.settings, nodes: raw.nodes, edges: raw.edges },
    false,
  );
  const authoring = record(authoringGraph(rawGraph), 'authoring graph');
  const callableGraph = validateWorkflowCallableGraphV2({
    ...authoring,
    schemaVersion: 2,
    ...(Object.hasOwn(raw, 'callable') ? { callable: raw.callable } : {}),
  });
  validateCallablePolicies(callableGraph, admission);
  validateCallablePolicies(callableGraph, current);
  const graph = parseWorkflowGraphForPublish(
    workflowCallStructuralProjectionV1(callableGraph),
    {
      schemaVersion: 1,
      definitions: admission.definitions.map(({ definition }) => definition),
    },
  );
  const executableGraph: WorkflowExecutableGraphV3 = {
    ...validateExecutableGraph(
      rawGraph,
      graph,
      admission,
      current,
      alreadyAdmitted(input.execution),
    ),
    ...(callableGraph.callable === undefined
      ? {}
      : { callable: callableGraph.callable }),
  };
  const expectedSelection = selectionFingerprintV3(
    admission,
    executableGraph,
    runtimePolicies,
  );
  if (envelope.compatibilitySelectionFingerprint !== expectedSelection)
    fail('compatibility selection fingerprint does not match');
  return {
    schemaVersion: 3,
    sourceGraphSchemaVersion: 2,
    graph: executableGraph,
    familyPolicy,
    runtimePolicies,
    configMigrations: [],
    compatibilitySelectionFingerprint: expectedSelection,
    compatibilityReleaseEpoch: admission.epoch,
    compatibilityReleaseFingerprint: admission.fingerprint,
  };
}

export function parseWorkflowExecutableV3(
  input: ParseInput,
): VerifiedWorkflowExecutableV3 {
  try {
    return freezeExecutable(
      parseBoundaryV3(input),
    ) as VerifiedWorkflowExecutableV3;
  } catch (error) {
    normalizeError(error);
  }
}

export function verifyWorkflowExecutableV3(
  input: ParseInput & { readonly checksum: unknown },
): CompiledWorkflowExecutableV3 {
  const envelope = parseWorkflowExecutableV3(input);
  const compiled = authenticate(envelope);
  if (input.checksum !== compiled.checksum)
    fail('workflow executable V3 checksum does not match');
  return compiled;
}

/** Closure/config-schema validation remains with the publication owner. */
export function buildWorkflowExecutableV3(input: {
  readonly graph: unknown;
  readonly release: unknown;
}): CompiledWorkflowExecutableV3 {
  try {
    const release = parseRegistryRelease(input.release);
    validateCallGlobals(WORKFLOW_CALL_RUNTIME_POLICIES_V1, release);
    const callableGraph = validateWorkflowCallableGraphV2(input.graph);
    validateCallablePolicies(callableGraph, release);
    const graph = parseWorkflowGraphForPublish(
      workflowCallStructuralProjectionV1(callableGraph),
      {
        schemaVersion: 1,
        definitions: release.definitions.map(({ definition }) => definition),
      },
    );
    const executableGraph: WorkflowExecutableGraphV3 = {
      ...compileExecutableGraph(graph, release),
      ...(callableGraph.callable === undefined
        ? {}
        : { callable: callableGraph.callable }),
    };
    return authenticate(
      parseWorkflowExecutableV3({
        envelope: {
          schemaVersion: 3,
          sourceGraphSchemaVersion: 2,
          graph: executableGraph,
          familyPolicy: WORKFLOW_CALL_FAMILY_POLICY_V1,
          runtimePolicies: WORKFLOW_CALL_RUNTIME_POLICIES_V1,
          configMigrations: [],
          compatibilitySelectionFingerprint: selectionFingerprintV3(
            release,
            executableGraph,
            WORKFLOW_CALL_RUNTIME_POLICIES_V1,
          ),
          compatibilityReleaseEpoch: release.epoch,
          compatibilityReleaseFingerprint: release.fingerprint,
        },
        admissionRelease: release,
      }),
    );
  } catch (error) {
    normalizeError(error);
  }
}
