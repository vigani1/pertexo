import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  workflowTriggerKinds,
  type TriggerKind,
} from '@/features/workflows/shape.public';

/** The published version's trigger kinds, or undefined until its graph is loaded. */
export function publishedTriggerKinds(
  versions: readonly WorkflowVersionResponse[] | undefined,
  publishedVersionId: string | null | undefined,
): readonly TriggerKind[] | undefined {
  const published = versions?.find(
    (version) => version.id === publishedVersionId,
  );
  return published === undefined
    ? undefined
    : workflowTriggerKinds(published.graph);
}
