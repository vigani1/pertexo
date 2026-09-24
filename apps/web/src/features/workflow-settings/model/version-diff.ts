import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { stepLabel } from '@/features/workflows/shape.public';
import { canonicalizeJson } from '@/lib/canonical-json';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type VersionDiff = Readonly<{
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  connectionsChanged: boolean;
}>;

/** A step's meaning without where it sits on the canvas. */
function stepFingerprint(node: WorkflowNode): string {
  return canonicalizeJson({ ...node, position: null });
}

function edgeFingerprint(edge: WorkflowGraphContract['edges'][number]) {
  return `${edge.source.nodeId}:${edge.source.port}>${edge.target.nodeId}:${edge.target.port}`;
}

/**
 * What changed from one version to the next, by step: added, removed, or
 * changed (configuration, mappings, connection or name). Moving a step on
 * the canvas is not a change.
 */
export function diffWorkflowGraphs(
  previous: WorkflowGraphContract,
  current: WorkflowGraphContract,
): VersionDiff {
  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const after = new Map(current.nodes.map((node) => [node.id, node]));
  const added = current.nodes
    .filter((node) => !before.has(node.id))
    .map(stepLabel);
  const removed = previous.nodes
    .filter((node) => !after.has(node.id))
    .map(stepLabel);
  const changed = current.nodes.flatMap((node) => {
    const earlier = before.get(node.id);
    return earlier !== undefined &&
      stepFingerprint(earlier) !== stepFingerprint(node)
      ? [stepLabel(node)]
      : [];
  });
  const edgesBefore = new Set(previous.edges.map(edgeFingerprint));
  const edgesAfter = new Set(current.edges.map(edgeFingerprint));
  const connectionsChanged =
    edgesBefore.size !== edgesAfter.size ||
    [...edgesAfter].some((edge) => !edgesBefore.has(edge));
  return { added, removed, changed, connectionsChanged };
}

export function isEmptyDiff(diff: VersionDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.connectionsChanged
  );
}
