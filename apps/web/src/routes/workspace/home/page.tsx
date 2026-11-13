import { useNavigate } from '@tanstack/react-router';
import { HomePage } from '@/features/overview/public';
import { useOpenCommandPalette } from '../shell/command-palette-context';
import { useWorkspaceScope } from '../shell/use-workspace-scope';

export function HomeRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const openSearch = useOpenCommandPalette();
  const navigate = useNavigate();
  return (
    <HomePage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      onOpenSearch={openSearch}
      onExampleCreated={(workflowId) => {
        void navigate({
          to: '/w/$workspaceId/workflows/$workflowId',
          params: { workspaceId: workspace.id, workflowId },
          search: { guide: 'first-run' },
        });
      }}
      onReviewExamples={() => {
        void navigate({
          to: '/w/$workspaceId/workflows',
          params: { workspaceId: workspace.id },
        });
      }}
    />
  );
}
