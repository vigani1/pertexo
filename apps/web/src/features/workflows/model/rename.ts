import { formatCount } from '@/lib/format/count';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  RESOURCE_NAME_MAX_LENGTH,
  workflowNameSchema,
  type WorkflowSummary,
} from '@pertexo/contracts';

/** The field message for a name the API would reject. */
export function workflowNameError(name: string): string | undefined {
  return workflowNameSchema.safeParse(name).success
    ? undefined
    : `Name the workflow in 1 to ${formatCount(RESOURCE_NAME_MAX_LENGTH, 'character')}.`;
}

/**
 * Editors rename active workflows (ADR 041). An archived workflow is
 * read-only until it is restored, like its draft.
 */
export function canRenameWorkflow(
  workspace: Pick<AccessibleWorkspace, 'capabilities' | 'status'>,
  workflow: Pick<WorkflowSummary, 'lifecycleStatus' | 'resourceAccess'>,
): boolean {
  return (
    workspace.status === 'active' &&
    workspace.capabilities.includes('workflow:update') &&
    workflow.lifecycleStatus === 'active' &&
    workflow.resourceAccess?.canEdit !== false
  );
}
