import { useParams } from '@tanstack/react-router';
import { PublicationReviewPage } from '@/features/workflow-publish/reviews.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';
export function PublicationReviewRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { requestId } = useParams({
    from: '/w/$workspaceId/shell/publish-reviews/$requestId',
  });
  return (
    <PublicationReviewPage
      key={`${user.id}:${workspace.id}:${requestId}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      reviewId={requestId}
      capabilities={workspace.capabilities}
    />
  );
}
