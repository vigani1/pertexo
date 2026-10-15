import { useParams } from '@tanstack/react-router';
import { TaskDetailPage } from '@/features/pending-tasks/pages.public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function RequestDetailRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { taskId } = useParams({
    from: '/w/$workspaceId/shell/requests/$taskId',
  });
  return (
    <TaskDetailPage
      key={`${user.id}:${workspace.id}:${taskId}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      taskId={taskId}
    />
  );
}
