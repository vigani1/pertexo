import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';

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
