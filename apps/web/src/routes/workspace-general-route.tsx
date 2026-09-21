import {
  useLoaderData,
  useNavigate,
  useRouter,
  useRouteContext,
  useSearch,
} from '@tanstack/react-router';
import { WorkspaceGeneralPage } from '@/features/workspaces/workspace-general.public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function WorkspaceGeneralRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/settings/general',
  });
  const data = useLoaderData({ from: '/w/$workspaceId/settings/general' });
  const search = useSearch({ from: '/w/$workspaceId/settings/general' });
  const navigate = useNavigate({ from: '/w/$workspaceId/settings/general' });
  const router = useRouter();
  if (data.workspace === null) return <WorkspaceUnavailablePage />;

  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={data.workspace}
      pageTitle="Workspace settings"
    >
      <WorkspaceGeneralPage
        apiClient={apiClient}
        user={data.user}
        workspace={data.workspace}
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
    </WorkspaceRouteShell>
  );
}
