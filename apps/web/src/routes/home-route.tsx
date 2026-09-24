import { HomePage } from '@/features/overview/public';
import { useWorkspaceScope } from './use-workspace-scope';

export function HomeRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return <HomePage apiClient={apiClient} user={user} workspace={workspace} />;
}
