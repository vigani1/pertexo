import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { WorkspaceGeneralPage } from '@/features/workspaces/workspace-general.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkspaceSettingsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({ from: '/w/$workspaceId/shell/settings' });
  const navigate = useNavigate({ from: '/w/$workspaceId/settings' });
  const router = useRouter();
  return (
    <WorkspaceGeneralPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      {...(search.operationId === undefined
        ? {}
        : { operationId: search.operationId })}
      onOperationChange={(operationId) =>
        void navigate({
          search: operationId === undefined ? {} : { operationId },
          replace: true,
        })
      }
      onWorkspaceChanged={() => void router.invalidate()}
    />
  );
}
