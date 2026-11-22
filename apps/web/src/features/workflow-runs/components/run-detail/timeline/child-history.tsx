import type { WorkflowCallSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { Notice } from '@/components/ui/notice';

export function ChildHistory({
  call,
  workspaceId,
}: Readonly<{ call: WorkflowCallSummary; workspaceId: string }>) {
  if (call.childHistory === 'retained' && call.childRunId !== null) {
    return (
      <Link
        to="/w/$workspaceId/runs/$runId"
        params={{
          workspaceId: workspaceId,
          runId: call.childRunId,
        }}
        className="inline-block underline underline-offset-4"
      >
        Open child run
      </Link>
    );
  }
  if (call.childHistory === 'unavailable') {
    return (
      <Notice tone="info">
        Child history is unavailable with your current access. The parent’s Call
        outcome remains visible.
      </Notice>
    );
  }
  if (call.childHistory === 'expired') {
    return (
      <Notice tone="info">
        Child history expired. The Call’s identity and outcome remain retained.
      </Notice>
    );
  }
  return null;
}
