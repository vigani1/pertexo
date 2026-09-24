import { Link, useLoaderData, useNavigate } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { WorkflowEditorPage } from '@/features/workflow-editor/public';
import { ResourceNotFound } from './system-pages';
import { useWorkflowHubScope } from './workflow-hub-scope';

/** The Build tab: the editor fills the immersive hub, bar included. */
export function WorkflowBuildRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  const { found } = useLoaderData({
    from: '/w/$workspaceId/workflows/$workflowId/',
  });
  const navigate = useNavigate();
  if (!found)
    return (
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
    );
  return (
    <WorkflowEditorPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      workflowId={workflowId}
      onRunAccepted={(runId) => {
        void navigate({
          to: '/w/$workspaceId/runs/$runId',
          params: { workspaceId: workspace.id, runId },
        });
      }}
    />
  );
}
