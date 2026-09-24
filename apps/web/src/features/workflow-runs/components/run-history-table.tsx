import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function RunHistoryTable({
  runs,
  workspaceId,
}: Readonly<{
  runs: readonly WorkflowRunReadSummary[];
  workspaceId: string;
}>) {
  return (
    <div>
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(15rem,1fr)_7rem_8rem_10rem_5rem_4rem] gap-4 border-b px-5 py-3 font-mono text-[0.68rem] tracking-[0.08em] text-muted-foreground xl:grid"
      >
        <span>Workflow and run</span>
        <span>Outcome</span>
        <span>Trigger</span>
        <span>Created</span>
        <span>Duration</span>
        <span className="text-right">Open</span>
      </div>
      <ul className="divide-y" aria-label="Workflow runs">
        {runs.map((run) => (
          <li
            key={run.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-4 transition-colors hover:bg-primary/[0.025] sm:px-5 xl:grid-cols-[minmax(15rem,1fr)_7rem_8rem_10rem_5rem_4rem] xl:items-center xl:gap-4"
          >
            <div className="min-w-0">
              <Link
                to="/w/$workspaceId/runs/$runId"
                params={{ workspaceId, runId: run.id }}
                title={run.workflowName ?? 'Workflow name unavailable'}
                className="block truncate font-heading text-base font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {run.workflowName ?? 'Workflow name unavailable'}
              </Link>
              <span className="sr-only">{run.id}</span>
              <p
                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                title={`Run ${run.id}; workflow ${run.workflowId}; version ${run.workflowVersionId}`}
              >
                Run {shortId(run.id)} · version {shortId(run.workflowVersionId)}
              </p>
            </div>
            <div className="col-start-1 row-start-2 xl:col-auto xl:row-auto">
              <Badge variant={statusVariant(run.status)}>
                {run.status.replaceAll('_', ' ')}
              </Badge>
            </div>
            <p className="col-span-2 text-sm capitalize text-muted-foreground xl:col-auto">
              <span className="xl:hidden">Trigger: </span>
              {run.triggerType}
            </p>
            <time
              dateTime={run.createdAt}
              className="col-span-2 text-sm text-muted-foreground xl:col-auto"
            >
              <span className="xl:hidden">Created: </span>
              {dateFormatter.format(new Date(run.createdAt))}
            </time>
            <p className="col-span-2 text-sm text-muted-foreground xl:col-auto">
              <span className="xl:hidden">Duration: </span>
              {duration(run)}
            </p>
            <div className="col-start-2 row-start-1 text-right xl:col-auto xl:row-auto">
              <RunLink workspaceId={workspaceId} run={run} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunLink({
  workspaceId,
  run,
}: Readonly<{ workspaceId: string; run: WorkflowRunReadSummary }>) {
  return (
    <Link
      to="/w/$workspaceId/runs/$runId"
      params={{ workspaceId, runId: run.id }}
      aria-label={`Open run ${run.id}`}
      className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:bg-white/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="sr-only xl:not-sr-only">Open</span>
      <ArrowRightIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function statusVariant(
  status: WorkflowRunReadSummary['status'],
): 'default' | 'secondary' | 'muted' | 'destructive' {
  if (status === 'succeeded') return 'default';
  if (status === 'failed' || status === 'timed_out') return 'destructive';
  if (status === 'running' || status === 'waiting') return 'secondary';
  return 'muted';
}

function duration(run: WorkflowRunReadSummary): string {
  if (run.startedAt === null || run.completedAt === null) return '—';
  const milliseconds = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (milliseconds < 1_000) return `${String(milliseconds)} ms`;
  if (milliseconds < 60_000)
    return `${String(Math.round(milliseconds / 1_000))} s`;
  return `${String(Math.round(milliseconds / 60_000))} min`;
}
