import { WorkflowReadBoundary } from '@/features/workflows/workflows-views.public';
import { WorkflowPresenceProvider } from '@/features/workflow-collaboration/workflow-collaboration-views.public';
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
 * The workflow bar sits inside the same workspace navigation as every page.
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
        <WorkspaceShellFrame layout="workflow">
          <Outlet />
        </WorkspaceShellFrame>
      </WorkflowPresenceProvider>
    </WorkflowReadBoundary>
  );
}
