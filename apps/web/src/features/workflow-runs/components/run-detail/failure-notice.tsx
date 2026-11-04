import type { WorkflowRunResponse } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { describeRunFailureReason } from '../../model/presentation/run-failure-reason';

export function RunFailureNotice({
  snapshot,
}: Readonly<{ snapshot: WorkflowRunResponse }>) {
  const reason = describeRunFailureReason(snapshot.run.failureReasonCode);
  if (reason === undefined) return null;
  return (
    <Notice tone="destructive">
      <p>{reason}</p>
      <p>
        No failed step can safely be retried using saved results. Review earlier
        effects before starting a full replay.
      </p>
    </Notice>
  );
}
