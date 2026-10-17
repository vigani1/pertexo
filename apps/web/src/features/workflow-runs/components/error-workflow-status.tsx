import { Link } from '@tanstack/react-router';
import type { WorkflowRunErrorWorkflow } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { formatDateTime } from '@/lib/format/time';

const refusals = {
  concurrency_limit:
    'The error workflow is already running and its concurrency policy skips new triggers.',
  target_not_published: 'The selected error workflow has no published version.',
  target_unavailable: 'The selected error workflow is archived or unavailable.',
  invalid_target:
    'The selected version cannot run as an error workflow. Publish it with When a workflow fails.',
  workspace_unavailable: 'The workspace cannot accept new runs.',
  queue_full: 'The error workflow’s 15-minute wait for queue capacity expired.',
};
function presentation(delivery: WorkflowRunErrorWorkflow) {
  if (delivery.status === 'refused')
    return {
      tone: 'warning' as const,
      glyph: 'attention' as const,
      title: 'Error workflow did not start',
      description:
        delivery.refusalCode === null
          ? null
          : `${delivery.refusalCode === 'queue_full' && delivery.queueWaitExpiresAt === null ? 'The workspace queue was full.' : refusals[delivery.refusalCode]} This run’s failure is still recorded.`,
    };
  if (delivery.status === 'accepted')
    return {
      tone: 'info' as const,
      glyph: 'success' as const,
      title: 'Error workflow started',
      description:
        delivery.acceptedRunId === null
          ? 'The error run’s history has expired.'
          : null,
    };
  const deadline = delivery.queueWaitExpiresAt;
  return {
    tone: 'info' as const,
    glyph: 'queued' as const,
    title:
      deadline === null
        ? 'Starting error workflow'
        : 'Error workflow is waiting for queue capacity',
    description:
      deadline === null ? null : `Retries until ${formatDateTime(deadline)}.`,
  };
}
export function ErrorWorkflowStatus({
  delivery,
  workspaceId,
}: Readonly<{
  delivery: WorkflowRunErrorWorkflow | undefined;
  workspaceId: string;
}>) {
  if (delivery === undefined) return null;
  const view = presentation(delivery);
  return (
    <Notice tone={view.tone} glyph={view.glyph}>
      <div className="flex flex-col gap-2">
        <p>{view.title}</p>
        {view.description === null ? null : <p>{view.description}</p>}
        {delivery.acceptedRunId === null ? null : (
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
