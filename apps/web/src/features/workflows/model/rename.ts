import type { AccessibleWorkspace } from '@pertexo/contracts';
import { workflowNameSchema, type WorkflowSummary } from '@pertexo/contracts';

/** The field message for a name the API would reject. */
export function workflowNameError(name: string): string | undefined {
  return workflowNameSchema.safeParse(name).success
    ? undefined
    : 'Name the workflow in 1 to 128 characters.';
}

/**
 * Editors rename active workflows (ADR 041). An archived workflow is
 * read-only until it is restored, like its draft.
 */
export function canRenameWorkflow(
  workspace: Pick<AccessibleWorkspace, 'capabilities' | 'status'>,
  workflow: Pick<WorkflowSummary, 'lifecycleStatus'>,
): boolean {
  return (
    workspace.status === 'active' &&
    workspace.capabilities.includes('workflow:update') &&
    workflow.lifecycleStatus === 'active'
  );
}
