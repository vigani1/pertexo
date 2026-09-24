import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import {
  formatDateTime,
  formatDurationMs,
  formatRelativeTime,
} from '@/lib/format-time';
import { shortRunId, workflowLabel } from '../../model/run-list';
import { describeRunStatus } from '../../model/run-status';
import { CopyValueButton } from '../copy-value-button';
import { RunRowMenu } from '../run-actions/run-row-menu';
import { ThreadBar } from '../thread-bar';
import { TriggerLabel } from '../trigger-label';

export type RunListVariant = 'workspace' | 'workflow';

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
  const title =
    variant === 'workspace'
      ? workflowLabel(run)
      : formatDateTime(run.createdAt);
  return (
    <li
      data-slot="run-row"
      className="group/row relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-md px-3 py-3 transition-colors hover:bg-white/[0.035] lg:grid-cols-[8.5rem_minmax(8rem,1fr)_6.5rem_6.5rem_5.5rem_minmax(4rem,7rem)_6.5rem_2rem] lg:gap-x-4 lg:py-2.5"
    >
      <Link
        to="/w/$workspaceId/runs/$runId"
        params={{ workspaceId: workspace.id, runId: run.id }}
        title={title}
        className="col-start-1 row-start-1 min-w-0 truncate font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60 lg:col-start-2"
      >
        {title}
      </Link>
      <div className="relative z-10 col-start-2 row-start-1 lg:col-start-8">
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
          className="lg:col-start-3 lg:row-start-1"
        />
        <time
          dateTime={run.createdAt}
          title={formatDateTime(run.createdAt)}
          className="text-subtle-foreground lg:col-start-4 lg:row-start-1"
        >
          {formatRelativeTime(run.createdAt, nowMs)}
        </time>
        <span className="font-mono text-xs text-muted-foreground lg:col-start-5 lg:row-start-1">
          {durationMs === undefined ? '—' : formatDurationMs(durationMs)}
        </span>
        <CopyValueButton
          value={run.id}
          display={shortRunId(run.id)}
          label="run ID"
          className="relative z-10 lg:col-start-7 lg:row-start-1"
        />
      </div>
      <ThreadBar
        share={share}
        tone={look.tone}
        className="col-span-2 row-start-3 lg:col-span-1 lg:col-start-6 lg:row-start-1"
      />
    </li>
  );
}
