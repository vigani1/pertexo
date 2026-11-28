import { useNavigate } from '@tanstack/react-router';
import { HomePage } from '@/features/overview/pages/home';
import { useWorkspaceScope } from '../shell/use-workspace-scope';

export function HomeRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const navigate = useNavigate();
  return (
    <HomePage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
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
