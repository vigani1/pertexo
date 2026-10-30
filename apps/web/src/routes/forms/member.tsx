import { useParams } from '@tanstack/react-router';
import { FormPage } from '@/features/forms/pages.public';
import { memberFormScope } from '@/features/forms/queries.public';
import { useWorkspaceScope } from '../workspace/shell/use-workspace-scope';
export function MemberFormRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { workflowId } = useParams({
    from: '/w/$workspaceId/shell/forms/$workflowId',
  });
  return (
    <FormPage
      key={`${user.id}:${workspace.id}:${workflowId}`}
      paused={workspace.status !== 'active'}
      scope={memberFormScope({
        apiClient,
        userId: user.id,
        workspaceId: workspace.id,
        workflowId,
      })}
    />
  );
}
