import { Link } from '@tanstack/react-router';
import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';

const refusals = {
  target_unavailable: 'The selected error workflow is archived or unavailable.',
  invalid_target:
    'The selected version cannot run as an error workflow. Publish it with When a workflow fails.',
  workspace_unavailable: 'The workspace cannot accept new runs.',
  queue_full: 'The workspace run queue is full.',
};
export function ErrorWorkflowStatus({
  delivery,
  workspaceId,
}: Readonly<{
  delivery: WorkflowRunErrorWorkflow | undefined;
  workspaceId: string;
}>) {
  if (delivery === undefined) return null;
  return (
    <Notice
      tone={delivery.status === 'refused' ? 'warning' : 'info'}
      glyph={
        delivery.status === 'pending'
          ? 'queued'
          : delivery.status === 'accepted'
            ? 'success'
            : 'attention'
      }
    >
      <div className="flex flex-col gap-2">
        <p>
          {delivery.status === 'pending'
            ? 'Starting error workflow'
            : delivery.status === 'accepted'
              ? 'Error workflow started'
              : 'Error workflow did not start'}
        </p>
        {delivery.refusalCode === null ? null : (
          <p>
            {refusals[delivery.refusalCode]} This run’s failure is still
            recorded.
          </p>
        )}
        {delivery.acceptedRunId === null ? (
          delivery.status === 'accepted' ? (
            <p>The error run’s history has expired.</p>
          ) : null
        ) : (
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: delivery.acceptedRunId }}
            className="underline underline-offset-4"
          >
            Open error run
          </Link>
        )}
      </div>
    </Notice>
  );
}
