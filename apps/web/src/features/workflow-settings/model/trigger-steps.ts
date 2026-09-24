import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { stepLabel } from '@/features/workflows/shape.public';

/**
 * A trigger's step name from the published version it belongs to, so cards
 * say "Receive order" rather than a node ID. Falls back when the version
 * isn't loaded.
 */
export function triggerStepName(
  versions: readonly WorkflowVersionResponse[] | undefined,
  trigger: Readonly<{ workflowVersionId: string; nodeId: string }>,
  fallback: string,
): string {
  const node = versions
    ?.find((version) => version.id === trigger.workflowVersionId)
    ?.graph.nodes.find((candidate) => candidate.id === trigger.nodeId);
  return node === undefined ? fallback : stepLabel(node);
}
