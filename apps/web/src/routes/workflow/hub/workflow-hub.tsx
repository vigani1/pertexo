import { WorkflowReadBoundary } from '@/features/workflows/hub.public';
import { WorkflowPresenceProvider } from '@/features/workflow-collaboration/presence.public';
import {
  Link,
  Outlet,
  useLoaderData,
  useRouteContext,
} from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { workflowsCrumb } from '../../root/breadcrumbs';
import { ResourceNotFound } from '../../root/status/pages';
import { WorkspaceShellFrame } from '../../workspace/shell/layout';

/**
 * Immersive frame for one workflow: no spine, its own floating bar. A
 * workflow that doesn't exist (or isn't visible) keeps the workspace shell,
 * so people can move on without reloading.
 */
export function WorkflowHubRoute() {
  const { apiClient, user, workspace, workflowId } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const { found } = useLoaderData({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const unavailable = (
    <WorkspaceShellFrame crumbs={[workflowsCrumb(workspace.id)]}>
      <ResourceNotFound resource="workflow">
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId: workspace.id }}
          className={buttonVariants({ variant: 'primary' })}
        >
          Back to workflows
        </Link>
      </ResourceNotFound>
    </WorkspaceShellFrame>
  );
  if (workflowId === null || !found) return unavailable;
  return (
    <WorkflowReadBoundary
      key={`${user.id}:${workspace.id}:${workflowId}`}
      apiClient={apiClient}
      userId={user.id}
      workspaceId={workspace.id}
      workflowId={workflowId}
      fallback={unavailable}
    >
      <WorkflowPresenceProvider
        key={`${user.id}:${workspace.id}:${workflowId}`}
        paused={workspace.status !== 'active'}
        scope={{
          apiClient,
          userId: user.id,
          workspaceId: workspace.id,
          workflowId,
        }}
      >
        <div className="relative min-h-svh bg-background">
          <div className="ambient ambient-still fixed" aria-hidden="true" />
          <main id="main" className="relative min-h-svh">
            <Outlet />
          </main>
        </div>
      </WorkflowPresenceProvider>
    </WorkflowReadBoundary>
  );
}
