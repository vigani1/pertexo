import { useNavigate, useSearch } from '@tanstack/react-router';
import { WorkflowPromotionPage } from '@/features/workflow-promotions/public';
import { promotionSearch } from '@/features/workflow-promotions/search.public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function WorkflowPromotionRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({
    from: '/w/$workspaceId/shell/settings-hub/settings/promotion',
  });
  const navigate = useNavigate();
  return (
    <WorkflowPromotionPage
      key={`${user.id}:${workspace.id}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      workspace={workspace}
      {...(search.selected === undefined ? {} : { selected: search.selected })}
      onSelect={(selections) => {
        void navigate({
          to: '/w/$workspaceId/settings/promotion',
          params: { workspaceId: workspace.id },
          search: promotionSearch(selections),
          replace: true,
        });
      }}
    />
  );
}
