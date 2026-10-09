import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';

export function canDuplicateWorkflow(
  workspace: Pick<AccessibleWorkspace, 'status' | 'capabilities'>,
  workflow: Pick<WorkflowSummary, 'lifecycleStatus'>,
) {
  return (
    workspace.status === 'active' &&
    workflow.lifecycleStatus === 'active' &&
    workspace.capabilities.includes('workflow:create') &&
    workspace.capabilities.includes('workflow:read')
  );
}
