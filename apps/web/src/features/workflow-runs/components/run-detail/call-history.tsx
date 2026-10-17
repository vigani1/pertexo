import { useHistoryPage } from '../../hooks/use-history-page';
import { HistoryPager } from './history/pager';
import type {
  WorkflowCallSummary,
  WorkflowParentCall,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { Notice } from '@/components/ui/notice';
import { StepError } from './step-details';
import type { AccessibleWorkspace } from '@pertexo/contracts';

export function CallHistory({
  calls,
  parentCall,
  labels,
  workspace,
}: Readonly<{
  calls: readonly WorkflowCallSummary[];
  parentCall: WorkflowParentCall | undefined;
  labels: ReadonlyMap<string, string>;
  workspace: AccessibleWorkspace;
}>) {
  const history = useHistoryPage(calls);
  if (calls.length === 0 && parentCall === undefined) return null;
  return (
    <section aria-label="Workflow Calls" className="space-y-3 text-sm">
      {parentCall === undefined ? null : (
        <p>
          Called by{' '}
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{
              workspaceId: workspace.id,
              runId: parentCall.parentRunId,
            }}
            className="underline underline-offset-4"
          >
            Open parent run
          </Link>
        </p>
      )}
      {calls.length === 0 ? null : (
        <>
          <h2 className="font-medium">Called workflows</h2>
          <ul className="space-y-3">
            {history.items.map((call, index) => (
              <li key={call.id} className="rounded-lg border p-3">
                <p className="font-medium">
                  {labels.get(call.invocationKey) ??
                    `Call ${String(history.start + index + 1)}`}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {call.status === 'pending'
                    ? 'Waiting to start the child.'
                    : call.status === 'accepted'
                      ? 'Waiting for the child to return its result.'
                      : call.status === 'succeeded'
                        ? 'Child result received.'
                        : `Call ${call.status.replaceAll('_', ' ')}.`}
                </p>
                {call.childHistory === 'retained' &&
                call.childRunId !== null ? (
                  <Link
                    to="/w/$workspaceId/runs/$runId"
                    params={{
                      workspaceId: workspace.id,
                      runId: call.childRunId,
                    }}
                    className="mt-2 inline-block underline underline-offset-4"
                  >
                    Open child run
                  </Link>
                ) : call.childHistory === 'expired' ? (
                  <Notice tone="info">
                    Child history expired. The Call’s identity and outcome
                    remain retained.
                  </Notice>
                ) : null}
                {call.detailsRetired ? (
                  <p className="mt-2 text-muted-foreground">
                    Call input and result details expired.
                  </p>
                ) : null}
                {call.safeErrorCode === null ? null : (
                  <StepError code={call.safeErrorCode} workspace={workspace} />
                )}
              </li>
            ))}
          </ul>
          <HistoryPager label="Called workflow pages" {...history} />
        </>
      )}
    </section>
  );
}
