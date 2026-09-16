import { useEffect } from 'react';
import {
  useLoaderData,
  useNavigate,
  useRouteContext,
} from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { LoginPage } from '@/features/auth/public';
import { WorkspaceSelectionPage } from '@/features/workspaces/public';
import { WorkflowListPage } from '@/features/workflows/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { useLogout } from './use-logout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function LoginRoute() {
  const { apiClient } = useRouteContext({ from: '/login' });
  return (
    <LoginPage
      apiClient={apiClient}
      navigateToProvider={(authorizationUrl) => {
        window.location.assign(authorizationUrl);
      }}
    />
  );
}

export function LogoutRoute() {
  const { apiClient } = useRouteContext({ from: '/logout' });
  const logout = useLogout(apiClient);
  const { completeLogout } = logout;
  useEffect(() => {
    void completeLogout();
  }, [completeLogout]);

  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-6"
    >
      {logout.error === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          Signing out…
        </p>
      ) : (
        <section className="flex max-w-md flex-col items-start gap-4">
          <h1 className="text-3xl font-semibold">Sign out did not complete</h1>
          <p role="alert" className="text-sm text-destructive">
            {logout.error}
          </p>
          <Button
            type="button"
            disabled={logout.pending}
            onClick={logout.requestLogout}
          >
            {logout.pending ? 'Retrying…' : 'Retry sign out'}
          </Button>
        </section>
      )}
    </main>
  );
}

export function WorkspaceSelectionRoute() {
  const { apiClient } = useRouteContext({ from: '/workspaces' });
  const { user, workspaces } = useLoaderData({ from: '/workspaces' });
  const navigate = useNavigate();
  const logoutState = useLogout(apiClient);
  return (
    <WorkspaceSelectionPage
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
      onLogout={logoutState.requestLogout}
    />
  );
}

export function WorkspaceRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/workflows',
  });
  const data = useLoaderData({ from: '/w/$workspaceId/workflows' });
  const navigate = useNavigate();
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  const workspace = data.workspace;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={workspace}
      pageTitle="Workflows"
    >
      <WorkflowListPage
        apiClient={apiClient}
        user={data.user}
        workspace={workspace}
        onOpenWorkflow={(workflowId) => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId',
            params: { workspaceId: workspace.id, workflowId },
          });
        }}
      />
    </WorkspaceRouteShell>
  );
}
