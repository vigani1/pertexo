import { WorkspaceDefault } from '@/features/workflow-settings/workflow-settings-views.public';
import { AssistantSettings } from '@/features/connections/connections-views.public';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { WorkspaceGeneralPage } from '@/features/workspaces/pages/workspace-general';
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
      assistantSettings={
        workspace.capabilities.includes('connection:manage') &&
        workspace.status === 'active' ? (
          <AssistantSettings
            scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
          />
        ) : undefined
      }
      automaticPauseSettings={
        workspace.capabilities.includes('workspace:manage') &&
        workspace.status === 'active' ? (
          <WorkspaceDefault scope={{ apiClient, userId: user.id, workspace }} />
        ) : undefined
      }
      onWorkspaceChanged={() => router.invalidate()}
      onLeft={() => navigate({ to: '/workspaces', replace: true })}
    />
  );
}
