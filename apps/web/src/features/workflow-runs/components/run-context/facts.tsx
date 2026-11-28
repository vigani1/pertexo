import type { ReactNode } from 'react';
import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { PageHeaderMeta } from '@/components/patterns/page-header';
import { StatusGuide } from '@/components/patterns/guidance/status-guide';
import {
  formatDateTime,
  formatDurationMs,
  formatMoment,
} from '@/lib/format/time';
import { pluralWord } from '@/lib/format/count';
import { runDurationMs, shortRunId } from '../../model/list/runs';
import { RUN_PAGE_GUIDE } from '../../model/presentation/run-guide';
import {
  describeTrigger,
  isActiveRunStatus,
} from '../../model/presentation/run-status';

function MetaFact({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="[&_b]:font-medium [&_b]:text-foreground">{children}</span>
  );
}

function deadlineFact(run: WorkflowRunReadSummary, nowMs: number): ReactNode {
  if (run.humanWait !== undefined)
    return (
      <>
        execution budget paused
        {run.humanWait.absoluteDeadlineAt === null ? null : (
          <>
            {' '}
            · absolute deadline{' '}
            <b>{formatDateTime(run.humanWait.absoluteDeadlineAt)}</b>
          </>
        )}
      </>
    );
  if (run.deadlineAt === null) return 'no deadline';
  const remaining = Date.parse(run.deadlineAt) - nowMs;
  if (!isActiveRunStatus(run.status))
    return (
      <>
        deadline <b>{formatMoment(run.deadlineAt)}</b>
      </>
    );
  return remaining > 0 ? (
    <>
      deadline in <b>{formatDurationMs(remaining)}</b>
    </>
  ) : (
    'deadline passed'
  );
}

/** The run's facts in mono: start, duration, trigger, version, deadline, stop. */
export function RunFacts({
  run,
  nowMs,
  workspaceId,
  versionLabel,
}: Readonly<{
  run: WorkflowRunReadSummary;
  nowMs: number;
  workspaceId: string;
  versionLabel: string | undefined;
}>) {
  const active = isActiveRunStatus(run.status);
  const durationMs = runDurationMs(run, nowMs);
  return (
    <PageHeaderMeta>
      <MetaFact>
        started <b>{formatMoment(run.startedAt ?? run.createdAt)}</b>
      </MetaFact>
      {run.completedAt === null ? null : (
        <MetaFact>
          stopped <b>{formatMoment(run.completedAt)}</b>
        </MetaFact>
      )}
      {durationMs === undefined ? null : (
        <MetaFact>
          <b>{formatDurationMs(durationMs)}</b>{' '}
          {active ? 'elapsed' : 'in total'}
        </MetaFact>
      )}
      <MetaFact>
        {describeTrigger(run.triggerType).toLocaleLowerCase()}
      </MetaFact>
      {versionLabel === undefined ? null : (
        <MetaFact>
          version{' '}
          <Link
            to="/w/$workspaceId/workflows/$workflowId/versions"
            params={{
              workspaceId,
              workflowId: run.workflowId,
            }}
            className="font-medium text-foreground underline decoration-current/20 underline-offset-4 hover:decoration-foreground"
          >
            {versionLabel}
          </Link>
        </MetaFact>
      )}
      <MetaFact>{deadlineFact(run, nowMs)}</MetaFact>
      {run.cancelRequestedAt === null ? null : (
        <MetaFact>
          stop requested <b>{formatMoment(run.cancelRequestedAt)}</b>
        </MetaFact>
      )}
      {run.replaySourceRunId == null ? null : (
        <MetaFact>
          {run.recovery === undefined ? 'replay of' : 'recovered from'}{' '}
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: run.replaySourceRunId }}
            className="font-medium text-foreground underline decoration-current/20 underline-offset-4 hover:decoration-foreground"
          >
            {shortRunId(run.replaySourceRunId)}
          </Link>
        </MetaFact>
      )}
      {run.recovery === undefined ? null : (
        <MetaFact>
          {String(run.recovery.reusedCount)} earlier{' '}
          {pluralWord(run.recovery.reusedCount, 'step')} reused
        </MetaFact>
      )}
      <StatusGuide sections={RUN_PAGE_GUIDE} className="-my-1 -ml-2" />
    </PageHeaderMeta>
  );
}
