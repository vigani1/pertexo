import { ApiTokensPage } from '@/features/api-tokens/public';
import { useWorkspaceScope } from './shell/use-workspace-scope';

export function ApiTokensRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <ApiTokensPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      userId={user.id}
      workspace={workspace}
    />
  );
}
