import {
  workflowExecutableChecksumSchema,
  workflowExecutionValues,
  valueSourceExecutionIdentity,
} from '@pertexo/workflow-model';
import type { WorkflowExecutable } from './workflow-executable.js';
import { digest } from './executable-digest.js';

function executableProjection(envelope: WorkflowExecutable) {
  return {
    graph: envelope.graph,
    runtimePolicies: envelope.runtimePolicies,
  };
}

// Legacy checksums remain verification-only. New identities include authored
// mapping/JSON value order; existing rows keep their original algorithm and value.
export function computeWorkflowExecutableChecksum(
  envelope: WorkflowExecutable,
): `wf:sha256:${string}` {
  return `wf:sha256:v2:${digest('pertexo.workflow-executable.v2', {
    ...executableProjection(envelope),
    graph: orderedGraph(envelope.graph),
  })}`;
}

export function verifiedWorkflowExecutableChecksum(
  envelope: WorkflowExecutable,
  checksum: unknown,
): `wf:sha256:${string}` | undefined {
  const parsed = workflowExecutableChecksumSchema.safeParse(checksum);
  if (!parsed.success) return undefined;
  const expected = parsed.data.startsWith('wf:sha256:v2:')
    ? computeWorkflowExecutableChecksum(envelope)
    : (`wf:sha256:${digest('pertexo.workflow-executable', executableProjection(envelope))}` as const);
  return expected === parsed.data ? expected : undefined;
}

function orderedGraph(graph: WorkflowExecutable['graph']): unknown {
  return {
    ...graph,
    ...(graph.callable === undefined
      ? {}
      : {
          callable: {
            ...graph.callable,
            result: valueSourceExecutionIdentity(graph.callable.result),
          },
        }),
    nodes: graph.nodes.map((node) => ({
      ...node,
      ...workflowExecutionValues(node),
      ...(node.structured === undefined
        ? {}
        : {
            structured: {
              ...node.structured,
              body: orderedGraph(node.structured.body),
            },
          }),
    })),
  };
}
