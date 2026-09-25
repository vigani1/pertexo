import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';

/** Row controls that stay out of the way until the row is hovered or focused. */
export const ROW_REVEAL_CLASS =
  'pointer-fine:opacity-0 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100 aria-expanded:opacity-100';

/** What a row can do; the list owns the dialogs and the run command. */
export type WorkflowRowActions = Readonly<{
  onRename: (workflow: WorkflowSummary) => void;
  onLifecycle: (workflow: WorkflowSummary) => void;
  onRun: (workflow: WorkflowSummary) => void;
  /** The workflow whose run is starting, if any. */
  runningId: string | undefined;
}>;
