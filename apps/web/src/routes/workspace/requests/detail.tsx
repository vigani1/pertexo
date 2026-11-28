import { TaskDetailPage } from '@/features/pending-tasks/pages/task-detail';
import { ApprovalRunThread } from '@/features/workflow-runs/workflow-runs-views.public';
import { useParams, useSearch } from '@tanstack/react-router';
import { useWorkspaceScope } from '../shell/use-workspace-scope';

export function RequestDetailRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { taskId } = useParams({
    from: '/w/$workspaceId/shell/requests/$taskId',
  });
  const { view } = useSearch({ from: '/w/$workspaceId/shell/requests' });
  return (
    <TaskDetailPage
      key={`${user.id}:${workspace.id}:${taskId}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      taskId={taskId}
      queueView={view}
      renderRunThread={(task) => (
        <ApprovalRunThread
          scope={{ apiClient, userId: user.id, workspace }}
          task={task}
        />
      )}
    />
  );
}
