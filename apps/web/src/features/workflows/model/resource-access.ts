import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
/** Present the server's resource actions through existing capability-based controls. */
export function workflowWorkspaceAccess(
  workspace: AccessibleWorkspace,
  access: WorkflowSummary['resourceAccess'],
): AccessibleWorkspace {
  if (access === undefined) return workspace;
  return {
    ...workspace,
    capabilities: workspace.capabilities.filter(
      (capability) =>
        (capability !== 'workflow:update' || access.canEdit) &&
        (capability !== 'workflow:publish' || access.canPublish),
    ),
  };
}
