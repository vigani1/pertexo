import type {
  WorkflowRunStatisticsResponse,
  WorkflowRunSummary,
} from '@pertexo/contracts';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { statusToneText } from '@/components/ui/status-tone';
import { cn } from '@/lib/utils';
import { Status } from '@/components/ui/status';
import {
  describeRunStatus,
  shortRunId,
} from '@/features/workflow-runs/run-labels.public';
import { formatDateTime } from '@/lib/format/time';
import { FORMAT_LOCALE } from '@/lib/format/locale';

type RunStatus = WorkflowRunSummary['status'];

/** Every link preserves the exact server snapshot's half-open bounds. */
// Enough to see where the work is; the rest wait behind "Show all".
const FIRST_WORKFLOWS = 8;

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
  const [showAll, setShowAll] = useState(false);
  const search = {
    createdAtFrom: snapshot.window.createdAtFrom,
    createdAtBefore: snapshot.window.createdAtBefore,
    range: 'custom' as const,
  };
  const statuses = Object.keys(snapshot.window.byStatus) as RunStatus[];
  const total = snapshot.window.total;
  const workflows = snapshot.workflows?.items ?? [];
  const busiest = Math.max(1, ...workflows.map((workflow) => workflow.total));
  const shownWorkflows = showAll
    ? workflows
    : workflows.slice(0, FIRST_WORKFLOWS);
  return (
    <div className="flex flex-col gap-6">
      {/* The count is its own sentence; the link sits beside it. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p>
          <span className="font-mono text-2xl">
            {total.toLocaleString(FORMAT_LOCALE)}
          </span>{' '}
          <span className="text-sm text-muted-foreground">
            {total === 1 ? 'run' : 'runs'} started {windowPhrase}
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
      {/* Every run in the window as one thread, coloured by where it stands. */}
      {total === 0 ? null : (
        <div
          aria-hidden="true"
          className="flex h-2.5 overflow-hidden rounded-full bg-surface-ink/[0.06]"
        >
          {statuses.map((status) => {
            const count = snapshot.window.byStatus[status];
            return count === 0 ? null : (
              <span
                key={status}
                title={`${describeRunStatus({ status }).label}: ${count.toLocaleString(FORMAT_LOCALE)}`}
                className={cn(
                  'h-full border-r border-background bg-current last:border-r-0',
                  statusToneText[describeRunStatus({ status }).tone],
                )}
                style={{ width: `${String((count / total) * 100)}%` }}
              />
            );
          })}
        </div>
      )}
      <ul
        className="flex flex-wrap gap-2"
        aria-label="Activity by current run status"
      >
        {statuses.map((status) => {
          const look = describeRunStatus({ status });
          const count = snapshot.window.byStatus[status];
          return (
            <li key={status}>
              <Link
                to="/w/$workspaceId/runs"
                params={{ workspaceId }}
                search={{ ...search, status }}
                aria-label={`${look.label} ${count.toLocaleString(FORMAT_LOCALE)}`}
                className={cn(
                  'focus-ring inline-flex items-center gap-2 rounded-md border border-surface-ink/7 bg-surface-ink/[0.025] px-2.5 py-1.5 text-sm transition-colors hover:border-surface-ink/15 hover:bg-surface-ink/[0.05] motion-reduce:transition-none',
                )}
              >
                <Status tone={look.tone}>{look.label}</Status>
                <span className="font-mono text-foreground/90">
                  {count.toLocaleString(FORMAT_LOCALE)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {snapshot.window.skippedTriggerEvents === undefined &&
      snapshot.window.coordinatedTriggerEvents === undefined ? null : (
        <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {snapshot.window.skippedTriggerEvents === undefined ? null : (
            <span title="Events that arrived while their workflow was at its limit. A skipped event starts no run.">
              <span className="font-mono text-foreground/85">
                {snapshot.window.skippedTriggerEvents.toLocaleString(
                  FORMAT_LOCALE,
                )}
              </span>{' '}
              trigger events skipped at a workflow’s limit
            </span>
          )}
          {snapshot.window.coordinatedTriggerEvents === undefined ? null : (
            <span title="Events matched up by trigger coordination, whether they waited, started a run or were skipped. Runs are counted separately.">
              <span className="font-mono text-foreground/85">
                {snapshot.window.coordinatedTriggerEvents.toLocaleString(
                  FORMAT_LOCALE,
                )}
              </span>{' '}
              events matched up by trigger coordination
            </span>
          )}
        </p>
      )}
      {snapshot.workflows === null ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Busiest workflows</h3>
          {workflows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No workflow runs in this window.
            </p>
          ) : (
            <ul aria-label="Activity by workflow" className="flex flex-col">
              {shownWorkflows.map((workflow) => (
                <li key={workflow.workflowId}>
                  <Link
                    to="/w/$workspaceId/runs"
                    params={{ workspaceId }}
                    search={{ ...search, workflowId: workflow.workflowId }}
                    className="focus-ring group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-ink/[0.035] motion-reduce:transition-none sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_3.5rem]"
                  >
                    <span className="min-w-0 truncate group-hover:text-accent-foreground">
                      {(canReadWorkflowNames ? workflow.workflowName : null) ??
                        `Workflow ${shortRunId(workflow.workflowId)}`}
                    </span>
                    {/* How busy, next to the busiest one in the window. */}
                    <span
                      aria-hidden="true"
                      className="col-span-2 row-start-2 h-1.5 rounded-full bg-surface-ink/[0.05] sm:col-span-1 sm:row-start-auto"
                    >
                      <span
                        className="block h-full rounded-full bg-action/60 group-hover:bg-action/80"
                        style={{
                          width: `${String(Math.max(2, (workflow.total / busiest) * 100))}%`,
                        }}
                      />
                    </span>
                    <span className="col-start-2 row-start-1 text-right font-mono sm:col-start-3">
                      {workflow.total.toLocaleString(FORMAT_LOCALE)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {workflows.length > FIRST_WORKFLOWS ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => {
                setShowAll(!showAll);
              }}
            >
              {showAll ? 'Show fewer' : `Show all ${String(workflows.length)}`}
            </Button>
          ) : null}
          {snapshot.workflows.truncated ? (
            <p className="text-xs text-subtle-foreground">
              Showing {workflows.length}{' '}
              {workflows.length === 1 ? 'workflow' : 'workflows'}. The total
              above includes the rest.
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
