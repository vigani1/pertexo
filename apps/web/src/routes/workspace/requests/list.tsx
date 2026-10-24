import { useNavigate, useSearch } from '@tanstack/react-router';
import { InboxViews } from '@/features/inbox/page.public';
import { TasksPage } from '@/features/pending-tasks/pages.public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function RequestsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({ from: '/w/$workspaceId/shell/requests' });
  const navigate = useNavigate({ from: '/w/$workspaceId/requests' });
  return (
    <TasksPage
      key={`${user.id}:${workspace.id}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      views={
        <InboxViews
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          current="requests"
        />
      }
      filters={search}
      onFilters={(filters) => void navigate({ search: filters })}
    />
  );
}
