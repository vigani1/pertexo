import type { WorkspaceInboxThread } from '@pertexo/contracts/schemas/workspace-inbox';
import { describeListedFailure } from '@/features/workflow-runs/failure.public';
import { describeRunStatus } from '@/features/workflow-runs/run-labels.public';
import { formatDateTime } from '@/lib/format-time';

/** How a failing workflow's notice reads in the inbox. */
export type InboxThreadView = Readonly<{
  look: ReturnType<typeof describeRunStatus>;
  /** "Failed once" or "Failed 4 times since Sep 28, 10:00". */
  occurrences: string;
  /** Where the latest run went wrong, when known. */
  step?: string;
  reason?: string;
}>;

export function describeInboxThread(
  thread: WorkspaceInboxThread,
): InboxThreadView {
  const failure = describeListedFailure(thread.latestFailedStep);
  return {
    look: describeRunStatus(thread.kind),
    occurrences:
      thread.occurrenceCount === 1
        ? 'Failed once'
        : `Failed ${thread.occurrenceCount.toLocaleString()} times since ${formatDateTime(thread.firstOccurredAt)}`,
    ...(failure.step === undefined ? {} : { step: failure.step }),
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
  };
}
