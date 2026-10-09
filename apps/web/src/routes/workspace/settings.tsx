import {
  useNavigate,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router';
import { WorkspaceGeneralPage } from '@/features/workspaces/workspace-general.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkspaceSettingsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { queryClient } = useRouteContext({ from: '__root__' });
  const navigate = useNavigate({ from: '/w/$workspaceId/settings' });
  const router = useRouter();
  return (
    <WorkspaceGeneralPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      onWorkspaceChanged={() => void router.invalidate()}
      onLeft={() => {
        // Leaving ended every session: forget this one's data and go to the
        // workspace picker, which asks for a new sign-in first.
        void (async () => {
          await queryClient.cancelQueries();
          queryClient.clear();
          await navigate({ to: '/workspaces', replace: true });
        })();
      }}
    />
  );
}
