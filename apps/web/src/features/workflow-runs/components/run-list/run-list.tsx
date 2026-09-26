import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import type { ApiClient } from '@/lib/api/client';
import {
  groupRunsByDay,
  runDurationMs,
  threadBarScale,
} from '../../model/run-list';
import { isActiveRunStatus } from '../../model/run-status';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { RunRow } from './run-row';
import { RUN_ROW_LAYOUT, type RunListVariant } from './run-row-layout';

/**
 * The operator's log: runs grouped under local days, with durations that
 * tick while runs are active and thread bars scaled to the visible set.
 */
export function RunList({
  apiClient,
  userId,
  workspace,
  runs,
  variant,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  runs: readonly WorkflowRunReadSummary[];
  variant: RunListVariant;
}>) {
  const ticking = runs.some((run) => isActiveRunStatus(run.status));
  const nowMs = useNow(1_000, ticking);
  const durations = new Map(
    runs.map((run) => [run.id, runDurationMs(run, nowMs)] as const),
  );
  const scale = threadBarScale([...durations.values()]);
  return (
    <div className="flex flex-col gap-8">
      {groupRunsByDay(runs, nowMs).map((group) => (
        <section key={group.key} aria-labelledby={`runs-day-${group.key}`}>
          <h2
            id={`runs-day-${group.key}`}
            className="mb-2 px-3 font-display text-xl leading-none text-foreground/90 [--display-optical-size:20]"
          >
            {group.heading}
          </h2>
          <ColumnHeadings variant={variant} />
          <ul
            aria-label={`Runs from ${group.heading}`}
            className="flex flex-col divide-y divide-white/[0.055]"
          >
            {group.runs.map((run) => {
              const durationMs = durations.get(run.id);
              return (
                <RunRow
                  key={run.id}
                  apiClient={apiClient}
                  userId={userId}
                  workspace={workspace}
                  run={run}
                  variant={variant}
                  durationMs={durationMs}
                  share={scale(durationMs)}
                  nowMs={nowMs}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ColumnHeadings({ variant }: Readonly<{ variant: RunListVariant }>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'hidden gap-x-4 border-b border-white/[0.055] px-3 pb-2 font-mono text-[0.68rem] text-subtle-foreground lg:grid',
        RUN_ROW_LAYOUT[variant].grid,
      )}
    >
      <span>Status</span>
      <span>{variant === 'workspace' ? 'Workflow' : 'Started'}</span>
      <span>Trigger</span>
      {variant === 'workspace' ? <span>Started</span> : null}
      <span>Took</span>
      <span />
      <span>Run</span>
      <span />
    </div>
  );
}
