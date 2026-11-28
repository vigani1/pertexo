import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { rolesAllowedTo } from '@/features/workspaces/public';

export function canControlWorkflowTriggers(
  workspace: AccessibleWorkspace,
  workflow: WorkflowSummary | undefined,
): boolean {
  return (
    workspace.status === 'active' &&
    rolesAllowedTo('workflow:publish').includes(workspace.role) &&
    workflow !== undefined &&
    (workflow.resourceAccess?.canPublish ?? true)
  );
}
