import {
  WorkflowPresenceSummary,
  WorkflowPresenceWarning,
  WorkflowEditingPresence,
} from '@/features/workflow-collaboration/presence.public';
import { useStepDiscussions } from '@/features/workflow-collaboration/discussions.public';
import {
  Link,
  useLoaderData,
  useNavigate,
  useSearch,
} from '@tanstack/react-router';
import { FirstRunGuide } from '@/features/workflows/first-run.public';
import { buttonVariants } from '@/components/ui/button-variants';
import { WorkflowEditorPage } from '@/features/workflow-editor/public';
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
  const { guide } = useSearch({
    from: '/w/$workspaceId/workflows/$workflowId/',
  });
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
          {guide === 'first-run' ? (
            <FirstRunGuide
              apiClient={apiClient}
              userId={user.id}
              workspaceId={workspace.id}
              workflowId={workflowId}
              onDismiss={() => {
                void navigate({
                  to: '/w/$workspaceId/workflows/$workflowId',
                  params: { workspaceId: workspace.id, workflowId },
                  search: {},
                  replace: true,
                });
              }}
            />
          ) : null}
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
      scope={{
        apiClient: apiClient,
        user: user,
        workspace: workspace,
        workflowId: workflowId,
      }}
    />
  );
}
