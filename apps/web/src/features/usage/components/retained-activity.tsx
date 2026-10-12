import type {
  WorkflowRunStatisticsResponse,
  WorkflowRunSummary,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import {
  describeRunStatus,
  shortRunId,
} from '@/features/workflow-runs/run-labels.public';
import { formatDateTime } from '@/lib/format/time';

type RunStatus = WorkflowRunSummary['status'];

/** Every link preserves the exact server snapshot's half-open bounds. */
export function RetainedActivity({
  snapshot,
  windowPhrase,
  workspaceId,
  canReadWorkflowNames,
}: Readonly<{
  snapshot: WorkflowRunStatisticsResponse;
  /** "in the last 24 hours" */
  windowPhrase: string;
  workspaceId: string;
  canReadWorkflowNames: boolean;
}>) {
  const search = {
    createdAtFrom: snapshot.window.createdAtFrom,
    createdAtBefore: snapshot.window.createdAtBefore,
    range: 'custom' as const,
  };
  return (
    <div className="space-y-6">
      {/* The count is its own sentence; the link sits beside it. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p>
          <span className="font-mono text-2xl">{snapshot.window.total}</span>{' '}
          <span className="text-sm text-muted-foreground">
            {snapshot.window.total === 1 ? 'run' : 'runs'} started{' '}
            {windowPhrase}
          </span>
        </p>
        <Link
          to="/w/$workspaceId/runs"
          params={{ workspaceId }}
          search={search}
          className="focus-ring rounded-sm text-sm text-accent-foreground underline underline-offset-4 hover:text-foreground"
        >
          View these runs
        </Link>
      </div>
      <ul
        className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Activity by current run status"
      >
        {(Object.keys(snapshot.window.byStatus) as RunStatus[]).map(
          (status) => {
            const look = describeRunStatus(status);
            return (
              <li key={status}>
                <Link
                  to="/w/$workspaceId/runs"
                  params={{ workspaceId }}
                  search={{ ...search, status }}
                  aria-label={`${look.label} ${String(snapshot.window.byStatus[status])}`}
                  className="focus-ring flex items-center justify-between gap-4 rounded-sm border-t border-border py-3 text-sm hover:text-accent-foreground"
                >
                  <Status tone={look.tone}>{look.label}</Status>
                  <span className="font-mono">
                    {snapshot.window.byStatus[status]}
                  </span>
                </Link>
              </li>
            );
          },
        )}
      </ul>
      {snapshot.workflows === null ? null : (
        <div>
          <h3 className="mb-2 text-sm font-semibold">By workflow</h3>
          {snapshot.workflows.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No workflow runs in this window.
            </p>
          ) : (
            <ul aria-label="Activity by workflow">
              {snapshot.workflows.items.map((workflow) => (
                <li key={workflow.workflowId}>
                  <Link
                    to="/w/$workspaceId/runs"
                    params={{ workspaceId }}
                    search={{ ...search, workflowId: workflow.workflowId }}
                    className="focus-ring flex min-w-0 items-center justify-between gap-4 rounded-sm border-t border-border py-3 text-sm hover:text-accent-foreground"
                  >
                    <span className="min-w-0 break-words">
                      {(canReadWorkflowNames ? workflow.workflowName : null) ??
                        `Workflow ${shortRunId(workflow.workflowId)}`}
                    </span>
                    <span className="font-mono">{workflow.total}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {snapshot.workflows.truncated ? (
            <p className="mt-2 text-xs text-subtle-foreground">
              Showing {snapshot.workflows.items.length}{' '}
              {snapshot.workflows.items.length === 1 ? 'workflow' : 'workflows'}
              . The total above includes the rest.
            </p>
          ) : null}
        </div>
      )}
      <p className="text-xs text-subtle-foreground">
        Runs started from{' '}
        <time dateTime={snapshot.window.createdAtFrom}>
          {formatDateTime(snapshot.window.createdAtFrom)}
        </time>{' '}
        to{' '}
        <time dateTime={snapshot.window.createdAtBefore}>
          {formatDateTime(snapshot.window.createdAtBefore)}
        </time>
        , counted once each by their current status. A replay counts as a new
        run; retries stay in the same run.
      </p>
    </div>
  );
}
