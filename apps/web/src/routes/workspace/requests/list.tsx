import {
  Outlet,
  useMatch,
  useNavigate,
  useSearch,
} from '@tanstack/react-router';
import { ListDetail } from '@/components/patterns/lists/list-detail';
import { InboxViews } from '@/features/inbox/inbox-views.public';
import { TasksPage } from '@/features/pending-tasks/pages/task-list';
import { useWorkspaceScope } from '../shell/use-workspace-scope';

export function RequestsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const filters = useSearch({ from: '/w/$workspaceId/shell/requests' });
  const selectedTaskId = useMatch({
    from: '/w/$workspaceId/shell/requests/$taskId',
    shouldThrow: false,
    select: (match) => match.params.taskId,
  });
  const navigate = useNavigate({ from: '/w/$workspaceId/requests' });
  return (
    <ListDetail
      key={`${user.id}:${workspace.id}`}
      showing={selectedTaskId === undefined ? 'list' : 'detail'}
      backLabel={
        filters.kind === 'approval' ? 'Back to approvals' : 'Back to requests'
      }
      onBack={() => void navigate({ to: '.', search: filters })}
      className="min-[56.25rem]:grid-cols-[minmax(16rem,1fr)_minmax(0,1.65fr)] min-[56.25rem]:gap-8 xl:grid-cols-[minmax(22.5rem,1fr)_minmax(0,1.65fr)] xl:gap-10"
      list={
        <TasksPage
          scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
          views={
            <InboxViews
              apiClient={apiClient}
              userId={user.id}
              workspace={workspace}
              current={filters.kind === 'approval' ? 'approvals' : 'requests'}
            />
          }
          filters={filters}
          {...(selectedTaskId === undefined ? {} : { selectedTaskId })}
          onFilters={(search) => void navigate({ to: '.', search })}
        />
      }
      detail={selectedTaskId === undefined ? undefined : <Outlet />}
    />
  );
}
