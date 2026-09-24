import { AccountSecurityPage } from '@/features/auth/account-security.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkspaceAccountRoute() {
  const { apiClient, user } = useWorkspaceScope();
  return (
    <AccountSecurityPage key={user.id} apiClient={apiClient} user={user} />
  );
}
