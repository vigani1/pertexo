import type { WorkflowGraphContract } from '@pertexo/contracts';
import { stepLabel } from '../shape';
import { canonicalizeJson } from '@/lib/canonical-json';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type VersionStepChange = Readonly<{ id: string; label: string }>;

export type VersionDiff = Readonly<{
  added: readonly VersionStepChange[];
  removed: readonly VersionStepChange[];
  changed: readonly VersionStepChange[];
  linksChanged: boolean;
  contractChanged: boolean;
  settingsChanged: boolean;
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
    .map((node) => ({ id: node.id, label: stepLabel(node) }));
  const removed = previous.nodes
    .filter((node) => !after.has(node.id))
    .map((node) => ({ id: node.id, label: stepLabel(node) }));
  const changed = current.nodes.flatMap((node) => {
    const earlier = before.get(node.id);
    return earlier !== undefined &&
      stepFingerprint(earlier) !== stepFingerprint(node)
      ? [{ id: node.id, label: stepLabel(node) }]
      : [];
  });
  const edgesBefore = new Set(previous.edges.map(edgeFingerprint));
  const edgesAfter = new Set(current.edges.map(edgeFingerprint));
  const linksChanged =
    edgesBefore.size !== edgesAfter.size ||
    [...edgesAfter].some((edge) => !edgesBefore.has(edge));
  const contractChanged =
    canonicalizeJson({ callable: previous.callable ?? null }) !==
    canonicalizeJson({ callable: current.callable ?? null });
  const settingsChanged =
    canonicalizeJson(previous.settings) !== canonicalizeJson(current.settings);
  return {
    added,
    removed,
    changed,
    linksChanged,
    contractChanged,
    settingsChanged,
  };
}

export function isEmptyDiff(diff: VersionDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.linksChanged &&
    !diff.contractChanged &&
    !diff.settingsChanged
  );
}
