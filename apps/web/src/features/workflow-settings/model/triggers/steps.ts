import type { WorkflowVersionResponse } from '@pertexo/contracts';
import { stepLabel } from '@/features/workflows/public';

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

/**
 * The published version's steps of one trigger kind, by name, for the kinds
 * the server keeps no trigger record of (forms and failure triggers).
 */
export function publishedStepNames(
  versions: readonly WorkflowVersionResponse[] | undefined,
  publishedVersionId: string | null | undefined,
  key: string,
): readonly Readonly<{ nodeId: string; name: string }>[] {
  const published = versions?.find(
    (version) => version.id === publishedVersionId,
  );
  return (published?.graph.nodes ?? [])
    .filter((node) => node.definition.key === key)
    .map((node) => ({ nodeId: node.id, name: stepLabel(node) }));
}
