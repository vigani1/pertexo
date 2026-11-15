import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  workflowTriggerKinds,
  type TriggerKind,
} from '@/features/workflows/public';

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

/**
 * The published version starts nothing: no webhook, schedule, form or
 * failure trigger. Unknown counts never claim that, so only someone whose
 * reads loaded can be told to add a first trigger.
 */
export function hasNoPublishedTriggers({
  editable,
  webhookCount,
  scheduleCount,
  form,
  onFailure,
}: Readonly<{
  editable: boolean;
  webhookCount: number | undefined;
  scheduleCount: number | undefined;
  form: boolean;
  onFailure: boolean;
}>): boolean {
  return (
    editable && webhookCount === 0 && scheduleCount === 0 && !form && !onFailure
  );
}
