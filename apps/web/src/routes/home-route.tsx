import { OverviewPage } from '@/features/overview/public';
import { useWorkspaceScope } from './use-workspace-scope';

export function HomeRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <OverviewPage apiClient={apiClient} user={user} workspace={workspace} />
  );
}
