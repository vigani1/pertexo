import { useParams } from '@tanstack/react-router';
import { ApprovalDetailPage } from '@/features/pending-tasks/pages.public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function ApprovalDetailRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { taskId } = useParams({
    from: '/w/$workspaceId/shell/approvals/$taskId',
  });
  return (
    <ApprovalDetailPage
      key={`${user.id}:${workspace.id}:${taskId}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      taskId={taskId}
    />
  );
}
