import {
  computeCompatibilitySelectionFingerprint,
  type DefinitionIdentity,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  type ExecutableRuntimePoliciesV1,
  type WorkflowExecutableNodeV2,
  type WorkflowExecutableV2,
  compareIdentity,
  digest,
  globalPolicies,
  token,
} from './executable-foundation.js';

function uniqueDefinitions(
  nodes: readonly Pick<WorkflowExecutableNodeV2, 'definition'>[],
): readonly DefinitionIdentity[] {
  const unique = new Map<string, DefinitionIdentity>();
  for (const { definition } of nodes) unique.set(token(definition), definition);
  return [...unique.values()].sort(compareIdentity);
}

/**
 * Computes the exact compatibility subset selected by one executable graph.
 * This identity primitive is shared by compilation and boundary verification;
 * keeping it independent prevents either side from importing the other.
 */
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

/**
 * Computes the V2 executable identity. It intentionally hashes only the
 * executable projection and leaves envelope provenance outside the digest.
 */
export function computeWorkflowExecutableChecksumV2(
  envelope: WorkflowExecutableV2,
): `wf:v2:sha256:${string}` {
  return `wf:v2:sha256:${digest(
    'pertexo.workflow-executable.v2',
    executableProjection(envelope),
  )}`;
}
