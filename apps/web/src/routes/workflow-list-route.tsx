import { WorkflowListPage } from '@/features/workflows/list.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkflowListRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <WorkflowListPage apiClient={apiClient} user={user} workspace={workspace} />
  );
}
