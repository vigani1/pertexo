import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { ApiClient } from '@/lib/api/client';
import {
  formatDateTime,
  formatDurationMs,
  formatRelativeTime,
} from '@/lib/format-time';
import { shortRunId, workflowLabel } from '../../model/run-list';
import { describeRunStatus } from '../../model/run-status';
import { CopyButton } from '@/components/ui/copy-button';
import { RunRowMenu } from '../run-actions/run-row-menu';
import { ThreadBar } from '../thread-bar';
import { TriggerLabel } from '../trigger-label';
import { RUN_ROW_LAYOUT, type RunListVariant } from './run-row-layout';

/** When a run started: relative, in mono, with the exact time on hover. */
function StartedAt({
  run,
  nowMs,
  className,
}: Readonly<{
  run: WorkflowRunReadSummary;
  nowMs: number;
  className?: string;
}>) {
  return (
    <time
      dateTime={run.createdAt}
      title={formatDateTime(run.createdAt)}
      className={cn('font-mono text-xs', className)}
    >
      {formatRelativeTime(run.createdAt, nowMs)}
    </time>
  );
}

/**
 * One run as a thread: status, name (or start time inside a workflow),
 * trigger, start, duration, a thread bar and its short ID. The whole row
 * opens the run; the ID and menu sit above that link.
 */
export function RunRow({
  apiClient,
  userId,
  workspace,
  run,
  variant,
  durationMs,
  share,
  nowMs,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  run: WorkflowRunReadSummary;
  variant: RunListVariant;
  durationMs: number | undefined;
  share: number;
  nowMs: number;
}>) {
  const look = describeRunStatus(run.status);
  const layout = RUN_ROW_LAYOUT[variant];
  const inWorkflow = variant === 'workflow';
  return (
    <li
      data-slot="run-row"
      className={cn(
        'group/row relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-md px-3 py-3 transition-colors hover:bg-white/[0.035] lg:gap-x-4 lg:py-2.5',
        layout.grid,
      )}
    >
      <Link
        to="/w/$workspaceId/runs/$runId"
        params={{ workspaceId: workspace.id, runId: run.id }}
        {...(inWorkflow
          ? { 'aria-label': `Run from ${formatDateTime(run.createdAt)}` }
          : {})}
        className={cn(
          "col-start-1 row-start-1 min-w-0 truncate font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
          layout.link,
        )}
      >
        {inWorkflow ? (
          <StartedAt run={run} nowMs={nowMs} className="text-sm" />
        ) : (
          workflowLabel(run)
        )}
      </Link>
      <div className={cn('relative z-10 col-start-2 row-start-1', layout.menu)}>
        <RunRowMenu
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          run={run}
        />
      </div>
      <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem] lg:contents">
        <Status tone={look.tone} className="lg:col-start-1 lg:row-start-1">
          {look.label}
        </Status>
        <TriggerLabel
          type={run.triggerType}
          className={cn('lg:row-start-1', layout.trigger)}
        />
        {inWorkflow ? null : (
          <StartedAt
            run={run}
            nowMs={nowMs}
            className="text-subtle-foreground lg:col-start-4 lg:row-start-1"
          />
        )}
        <span
          className={cn(
            'font-mono text-xs text-muted-foreground lg:row-start-1',
            layout.took,
          )}
        >
          {durationMs === undefined ? '—' : formatDurationMs(durationMs)}
        </span>
        <CopyButton
          value={run.id}
          display={shortRunId(run.id)}
          label="Copy run ID"
          className={cn('relative z-10 lg:row-start-1', layout.id)}
        />
      </div>
      <ThreadBar
        share={share}
        tone={look.tone}
        className={cn(
          'col-span-2 row-start-3 lg:col-span-1 lg:row-start-1',
          layout.bar,
        )}
      />
    </li>
  );
}
