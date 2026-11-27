import { ListDetail } from '@/components/patterns/lists/list-detail';
import { InboxViews } from '@/features/inbox/inbox-views.public';
import { TasksPage } from '@/features/pending-tasks/pages/task-list';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { TaskDetailPage } from '@/features/pending-tasks/pages/task-detail';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function RequestDetailRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { taskId } = useParams({
    from: '/w/$workspaceId/shell/requests/$taskId',
  });
  const filters = useSearch({ from: '/w/$workspaceId/shell/requests/$taskId' });
  const navigate = useNavigate({ from: '/w/$workspaceId/requests/$taskId' });
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  return (
    <ListDetail
      list={
        <TasksPage
          scope={scope}
          filters={filters}
          selectedTaskId={taskId}
          views={
            <InboxViews
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              current="requests"
            />
          }
          onFilters={(search) =>
            void navigate({
              to: '/w/$workspaceId/requests',
              params: { workspaceId: workspace.id },
              search,
            })
          }
        />
      }
      detail={
        <TaskDetailPage
          key={`${user.id}:${workspace.id}:${taskId}`}
          scope={scope}
          taskId={taskId}
          backSearch={filters}
        />
      }
    />
  );
}
