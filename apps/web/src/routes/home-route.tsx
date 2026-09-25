import { HomePage } from '@/features/overview/public';
import { useOpenCommandPalette } from './command-palette-context';
import { useWorkspaceScope } from './use-workspace-scope';

export function HomeRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const openSearch = useOpenCommandPalette();
  return (
    <HomePage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      onOpenSearch={openSearch}
    />
  );
}
