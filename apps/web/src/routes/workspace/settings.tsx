import { useNavigate, useRouter } from '@tanstack/react-router';
import { WorkspaceGeneralPage } from '@/features/workspaces/workspace-general.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';

export function WorkspaceSettingsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const navigate = useNavigate({ from: '/w/$workspaceId/settings' });
  const router = useRouter();
  return (
    <WorkspaceGeneralPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      onWorkspaceChanged={() => router.invalidate()}
      onLeft={() => navigate({ to: '/workspaces', replace: true })}
    />
  );
}
