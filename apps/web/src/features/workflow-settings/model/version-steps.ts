import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  definitionName,
  stepLabel,
  triggerKindOf,
} from '@/features/workflows/shape.public';

export function stepCountLabel(count: number): string {
  return count === 1 ? '1 step' : `${String(count)} steps`;
}

export type VersionStep = Readonly<{
  id: string;
  label: string;
  kind: string;
  trigger: boolean;
}>;

/** Steps in reading order: triggers first, then left to right on the canvas. */
export function versionSteps(
  graph: WorkflowGraphContract,
): readonly VersionStep[] {
  return graph.nodes
    .map((node) => ({
      id: node.id,
      label: stepLabel(node),
      kind: definitionName(node.definition.key),
      trigger: triggerKindOf(node.definition.key) !== undefined,
      x: node.position.x,
      y: node.position.y,
    }))
    .sort(
      (a, b) => Number(b.trigger) - Number(a.trigger) || a.x - b.x || a.y - b.y,
    )
    .map(({ id, label, kind, trigger }) => ({ id, label, kind, trigger }));
}
