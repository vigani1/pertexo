import { Link, useLoaderData, useNavigate } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { WorkflowEditorPage } from '@/features/workflow-editor/public';
import { ResourceNotFound } from './system-pages';
import { useWorkflowHubScope } from './workflow-hub-scope';

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
    <div className="h-svh min-h-0">
      <WorkflowEditorPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        workflowId={workflowId}
        onBack={() =>
          void navigate({
            to: '/w/$workspaceId/workflows',
            params: { workspaceId: workspace.id },
          })
        }
        onRunAccepted={(runId) => {
          void navigate({
            to: '/w/$workspaceId/runs/$runId',
            params: { workspaceId: workspace.id, runId },
          });
        }}
        onOpenSettings={() => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId/settings',
            params: { workspaceId: workspace.id, workflowId },
          });
        }}
      />
    </div>
  );
}
