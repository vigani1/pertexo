import { Link, Outlet, useRouteContext } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { ResourceNotFound } from './system-pages';

/** Immersive frame for one workflow: no spine, its own floating bar. */
export function WorkflowHubRoute() {
  const { workspace, workflowId } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  return (
    <div className="relative min-h-svh bg-background">
      <div className="ambient fixed" aria-hidden="true" />
      <main id="main" className="relative min-h-svh">
        {workflowId === null ? (
          <div className="px-4">
            <ResourceNotFound resource="workflow">
              <Link
                to="/w/$workspaceId/workflows"
                params={{ workspaceId: workspace.id }}
                className={buttonVariants({ variant: 'primary' })}
              >
                Back to workflows
              </Link>
            </ResourceNotFound>
          </div>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
