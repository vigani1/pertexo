import {
  WorkflowPresenceSummary,
  WorkflowPresenceWarning,
  WorkflowEditingPresence,
} from '@/features/workflow-collaboration/presence.public';
import { useStepDiscussions } from '@/features/workflow-collaboration/discussions.public';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLoaderData, useNavigate } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { WorkflowEditorPage } from '@/features/workflow-editor/public';
import { workflowSettingsKeys } from '@/features/workflow-settings/queries.public';
import { WorkflowPausedBanner } from '@/features/workflow-settings/auto-pause.public';
import { ResourceNotFound } from '../root/status/pages';
import { useWorkflowHubScope } from './hub/scope';

/** The Build tab: the editor fills the immersive hub, bar included. */
export function WorkflowBuildRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  const { found } = useLoaderData({
    from: '/w/$workspaceId/workflows/$workflowId/',
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const stepDiscussions = useStepDiscussions();
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
      stepDiscussions={stepDiscussions}
      headerPresence={<WorkflowPresenceSummary />}
      renderEditingPresence={(source) => (
        <WorkflowEditingPresence source={source} />
      )}
      triggerNotice={
        <>
          {' '}
          <WorkflowPresenceWarning />
          <WorkflowPausedBanner
            key={`${user.id}:${workspace.id}:${workflowId}`}
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
            workflowId={workflowId}
          />
        </>
      }
      onRunAccepted={(runId) => {
        void navigate({
          to: '/w/$workspaceId/runs/$runId',
          params: { workspaceId: workspace.id, runId },
        });
      }}
      // Versions, Triggers and Settings read what a publish changes.
      onPublished={() => {
        void queryClient.invalidateQueries({
          queryKey: workflowSettingsKeys.root(
            user.id,
            workspace.id,
            workflowId,
          ),
        });
      }}
      scope={{
        apiClient: apiClient,
        user: user,
        workspace: workspace,
        workflowId: workflowId,
      }}
    />
  );
}
