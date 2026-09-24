import {
  useLoaderData,
  useNavigate,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router';
import { WorkspaceSelectionPage } from '@/features/workspaces/selection.public';
import { useLogout } from './use-logout';

export function WorkspaceSelectionRoute() {
  const { apiClient } = useRouteContext({ from: '/workspaces' });
  const { user, workspaces } = useLoaderData({ from: '/workspaces' });
  const navigate = useNavigate();
  const router = useRouter();
  const logoutState = useLogout(apiClient);
  return (
    <WorkspaceSelectionPage
      apiClient={apiClient}
      user={user}
      workspaces={workspaces}
      logoutPending={logoutState.pending}
      {...(logoutState.error === undefined
        ? {}
        : { logoutError: logoutState.error })}
      onSelect={(workspace) => {
        void navigate({
          to:
            workspace.status === 'pending_deletion'
              ? '/w/$workspaceId/settings/general'
              : '/w/$workspaceId/workflows',
          params: { workspaceId: workspace.id },
        });
      }}
      onCreated={(workspace) => {
        void navigate({
          to: '/w/$workspaceId/workflows',
          params: { workspaceId: workspace.id },
        });
      }}
      onSessionInvalidated={() => {
        void router.invalidate();
      }}
      onLogout={logoutState.requestLogout}
    />
  );
}
