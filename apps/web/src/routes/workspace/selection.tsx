import {
  useLoaderData,
  useNavigate,
  useRouteContext,
} from '@tanstack/react-router';
import { WorkspaceSelectionPage } from '@/features/workspaces/selection.public';
import { useLogout } from '../auth/use-logout';

export function WorkspaceSelectionRoute() {
  const { apiClient } = useRouteContext({ from: '/workspaces' });
  const { user, workspaces } = useLoaderData({ from: '/workspaces' });
  const navigate = useNavigate();
  const logoutState = useLogout(apiClient);
  return (
    <WorkspaceSelectionPage
      apiClient={apiClient}
      user={user}
      workspaces={workspaces}
      onSelect={(workspace) => {
        void navigate({
          to:
            workspace.status === 'pending_deletion'
              ? '/w/$workspaceId/settings'
              : '/w/$workspaceId',
          params: { workspaceId: workspace.id },
        });
      }}
      onCreated={(workspace) => {
        void navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: workspace.id },
        });
      }}
      session={{
        ...(logoutState.error === undefined
          ? {}
          : { logoutError: logoutState.error }),
        logoutPending: logoutState.pending,
        onLogout: logoutState.requestLogout,
      }}
    />
  );
}
