import {
  Link,
  Outlet,
  useLoaderData,
  useRouteContext,
} from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { workflowsCrumb } from './breadcrumbs';
import { ResourceNotFound } from './system-pages';
import { WorkspaceShellFrame } from './workspace-shell-route';

/**
 * Immersive frame for one workflow: no spine, its own floating bar. A
 * workflow that doesn't exist (or isn't visible) keeps the workspace shell,
 * so people can move on without reloading.
 */
export function WorkflowHubRoute() {
  const { workspace, workflowId } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const { found } = useLoaderData({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  if (workflowId === null || !found)
    return (
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
  return (
    <div className="relative min-h-svh bg-background">
      <div className="ambient fixed" aria-hidden="true" />
      <main id="main" className="relative min-h-svh">
        <Outlet />
      </main>
    </div>
  );
}
