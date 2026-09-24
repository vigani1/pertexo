import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';

export type LifecycleAction = 'archive' | 'restore';

/** What the person confirmed, captured when the confirmation opened. */
export type LifecycleIntent = Readonly<{
  command: LifecycleAction;
  expectedLifecycleRevision: number;
}>;

export function lifecycleIntentFor(
  workflow: Pick<WorkflowSummary, 'lifecycleStatus' | 'lifecycleRevision'>,
): LifecycleIntent {
  return {
    command: workflow.lifecycleStatus === 'archived' ? 'restore' : 'archive',
    expectedLifecycleRevision: workflow.lifecycleRevision,
  };
}

/** The consequences of each lifecycle change, in the words people see. */
export const LIFECYCLE_CONSEQUENCES: Readonly<
  Record<LifecycleAction, readonly string[]>
> = {
  archive: [
    'New runs stop, and its webhooks and schedules pause.',
    'Runs already in progress finish normally.',
    'Its versions, draft and run history are kept. You can restore it any time.',
  ],
  restore: [
    'It can run again.',
    'Webhooks and schedules from its published version switch back on. Schedules you turned off stay off.',
  ],
};
