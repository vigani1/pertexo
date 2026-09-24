import { ConnectionsPage } from '@/features/connections/public';
import { useWorkspaceScope } from './use-workspace-scope';

export function ConnectionsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <ConnectionsPage apiClient={apiClient} user={user} workspace={workspace} />
  );
}
