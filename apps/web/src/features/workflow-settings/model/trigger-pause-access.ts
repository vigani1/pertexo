import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { rolesAllowedTo } from '@/features/workspaces/public';

export function canControlWorkflowTriggers(
  workspace: AccessibleWorkspace,
  workflow: WorkflowSummary | undefined,
): boolean {
  const capability = 'workflow:publish';
  return (
    workspace.status === 'active' &&
    rolesAllowedTo(capability).includes(workspace.role) &&
    workspace.capabilities.includes(capability) &&
    workflow !== undefined &&
    (workflow.resourceAccess?.canPublish ?? true)
  );
}
