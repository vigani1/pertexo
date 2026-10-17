import { useNavigate, useParams } from '@tanstack/react-router';
import { DataTablesPage } from '@/features/data-tables/public';
import { useWorkspaceScope } from './shell/use-workspace-scope';
export function DataTablesRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  return (
    <DataTablesPage
      key={`${user.id}:${workspace.id}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      workspace={workspace}
      tableId={params.tableId}
      onOpen={(id) => {
        if (id === undefined)
          void navigate({
            to: '/w/$workspaceId/data-tables',
            params: { workspaceId: workspace.id },
          });
        else
          void navigate({
            to: '/w/$workspaceId/data-tables/$tableId',
            params: { workspaceId: workspace.id, tableId: id },
          });
      }}
    />
  );
}
