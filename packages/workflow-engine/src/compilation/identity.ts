import { type WorkflowExecutable, digest } from './foundation.js';

function executableProjection(envelope: WorkflowExecutable): unknown {
  return {
    schemaVersion: envelope.schemaVersion,
    sourceGraphSchemaVersion: envelope.sourceGraphSchemaVersion,
    graph: envelope.graph,
    runtimePolicies: envelope.runtimePolicies,
  };
}

/** The executable's checksum, stored beside it when a workflow is published. */
export function computeWorkflowExecutableChecksum(
  envelope: WorkflowExecutable,
): `wf:sha256:${string}` {
  return `wf:sha256:${digest(
    'pertexo.workflow-executable',
    executableProjection(envelope),
  )}`;
}
