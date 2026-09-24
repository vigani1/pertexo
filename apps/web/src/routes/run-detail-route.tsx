import {
  Link,
  useLoaderData,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { RunDetailPage } from '@/features/workflow-runs/public';
import { ResourceNotFound } from './system-pages';
import { useWorkspaceScope } from './use-workspace-scope';

export function RunDetailRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { found } = useLoaderData({
    from: '/w/$workspaceId/shell/runs/$runId',
  });
  const { runId } = useParams({ from: '/w/$workspaceId/shell/runs/$runId' });
  const navigate = useNavigate();
  if (!found)
    return (
      <ResourceNotFound resource="run">
        <Link
          to="/w/$workspaceId/runs"
          params={{ workspaceId: workspace.id }}
          className={buttonVariants({ variant: 'primary' })}
        >
          Back to runs
        </Link>
      </ResourceNotFound>
    );
  return (
    <RunDetailPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      runId={runId}
      onRunAccepted={(acceptedRunId) => {
        void navigate({
          to: '/w/$workspaceId/runs/$runId',
          params: { workspaceId: workspace.id, runId: acceptedRunId },
        });
      }}
    />
  );
}
