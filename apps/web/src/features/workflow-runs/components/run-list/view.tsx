import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatCount } from '@/lib/format/count';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type {
  AccessibleWorkspace,
  WorkflowRunListItem,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { groupRunsByDay, runDurationMs } from '../../model/list/runs';
import { isActiveRunStatus } from '../../model/presentation/run-status';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import { cn } from '@/lib/class-names';
import { admissionBlockerWords } from '../../model/presentation/admission';
import { RunRow } from './row';
import { RUN_ROW_LAYOUT, type RunListVariant } from './row-layout';

const DAY_PREVIEW_COUNT = 6;

/**
 * The operator's log: runs grouped under local days, with durations that
 * tick while runs are active.
 */
export function RunList({
  apiClient,
  userId,
  workspace,
  runs,
  variant,
  partial = false,
  oldestLoadedDay,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  runs: readonly WorkflowRunListItem[];
  variant: RunListVariant;
  partial?: boolean;
  oldestLoadedDay?: string | undefined;
}>) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const ticking = runs.some((run) => isActiveRunStatus(run.status));
  const nowMs = useNow({ intervalMs: CLOCK_TICK.seconds, enabled: ticking });
  const durations = new Map(
    runs.map((run) => [run.id, runDurationMs(run, nowMs)] as const),
  );
  const waiting = runs.filter(
    (run) =>
      run.status === 'queued' &&
      (run.admissionBlockers?.reasons.length ?? 0) > 0,
  );
  const waitingFor = admissionBlockerWords([
    ...new Set(waiting.flatMap((run) => run.admissionBlockers?.reasons ?? [])),
  ]);
  return (
    <div className="flex flex-col gap-8">
      {waiting.length < 2 ? null : (
        // Said once here, so each queued row needs only its reason.
        <p className="px-3 text-sm text-muted-foreground">
          {waiting.length} queued runs are waiting for {waitingFor}. They start
          in turn as capacity frees up; the queue can change.
        </p>
      )}
      {groupRunsByDay(runs, nowMs).map((group) => {
        const showAll = expanded.has(group.key);
        const preview = variant === 'workspace' && !showAll;
        const hidden = group.runs.length - DAY_PREVIEW_COUNT;
        const complete =
          !partial ||
          (oldestLoadedDay !== undefined && group.key > oldestLoadedDay);
        const failures = group.runs.filter(
          (run) => run.status === 'failed',
        ).length;
        return (
          <section key={group.key} aria-labelledby={`runs-day-${group.key}`}>
            <RuleHeading id={`runs-day-${group.key}`} className="mb-2 px-3">
              {group.heading}
              {complete ? (
                <span className="ml-2 font-mono text-xs font-normal text-subtle-foreground">
                  {formatCount(group.runs.length, 'run')}
                  {failures === 0 ? '' : ` · ${String(failures)} failed`}
                </span>
              ) : null}
            </RuleHeading>
            <ColumnHeadings variant={variant} />
            <ul
              id={`runs-rows-${group.key}`}
              aria-label={`Runs from ${group.heading}`}
              className="flex flex-col"
            >
              {(preview
                ? group.runs.slice(0, DAY_PREVIEW_COUNT)
                : group.runs
              ).map((run) => {
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
                  />
                );
              })}
            </ul>
            {variant === 'workspace' && hidden > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-controls={`runs-rows-${group.key}`}
                aria-expanded={showAll}
                onClick={() => {
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  });
                }}
              >
                {showAll
                  ? `Show fewer from ${group.heading}`
                  : `Show ${String(hidden)} more from ${group.heading}`}
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ColumnHeadings({ variant }: Readonly<{ variant: RunListVariant }>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'mb-1 hidden gap-x-4 border-b border-border px-3 pb-2 font-mono text-caption text-subtle-foreground md:grid',
        RUN_ROW_LAYOUT[variant].grid,
      )}
    >
      <span>Status</span>
      <span>{variant === 'workspace' ? 'Workflow' : 'Started'}</span>
      {/* A tablet's table drops Trigger; so does its name. */}
      <span className="max-lg:hidden">Trigger</span>
      {variant === 'workspace' ? <span>Started</span> : null}
      <span>Took</span>
      <span>Run</span>
      <span />
    </div>
  );
}
