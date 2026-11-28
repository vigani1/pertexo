import type { WorkflowRunSummary } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Link } from '@tanstack/react-router';
import { StatusMark } from '@/components/patterns/status/status-mark';
import {
  describeRunStatus,
  isActiveRunStatus,
} from '@/features/workflow-runs/public';
import { formatClock } from '@/lib/format/time';
import { useEditorSession } from '../../model/state/context';
import type { useLastRun } from '../../hooks/use-last-run';
import type { LastRunOverlay } from '../../model/canvas/last-run';

/**
 * The line above the canvas that says which run the results under the
 * steps come from, links to it and hides or shows them (from 640px; a
 * phone reads and runs). Nothing before a workflow's first run.
 */
export function LastRunLine({
  lastRun,
}: Readonly<{ lastRun: ReturnType<typeof useLastRun> }>) {
  const { overlay, shown, toggle } = lastRun;
  const { scope } = useEditorSession();
  if (overlay === undefined) return null;
  const { run } = overlay;
  const look = describeRunStatus({
    status: run.status,
    stopRequested: run.cancelRequestedAt !== null,
  });
  const live = isActiveRunStatus(run.status);
  return (
    <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-3 font-mono text-caption text-subtle-foreground">
      <StatusMark tone={look.tone}>
        {runTimeLabel(run, look.label, live)}
      </StatusMark>
      {!live && shown ? (
        <span className="max-xl:hidden">
          Under each step: what it did in that run
        </span>
      ) : null}
      <Link
        to="/w/$workspaceId/runs/$runId"
        params={{ workspaceId: scope.workspace.id, runId: run.id }}
        className={buttonVariants({ variant: 'link', size: 'sm' })}
      >
        Open run
      </Link>
      {!live ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="max-sm:hidden"
          onClick={toggle}
        >
          {shown ? 'Hide results' : 'Show results'}
        </Button>
      ) : null}
      {live ? <LiveProgress overlay={overlay} look={look} /> : null}
    </div>
  );
}

function runTimeLabel(
  run: WorkflowRunSummary,
  status: string,
  live: boolean,
): string {
  if (!live) return `${status} · last run ${formatClock(run.createdAt)}`;
  return run.startedAt === null
    ? status
    : `Live run started ${formatClock(run.startedAt)}`;
}

function LiveProgress({
  overlay,
  look,
}: Readonly<{
  overlay: LastRunOverlay;
  look: ReturnType<typeof describeRunStatus>;
}>) {
  const [step, ...others] = overlay.currentSteps;
  const current = step === undefined ? look.label : `Now at ${step.title}`;
  let detail;
  if (others.length > 0) detail = `+${String(others.length)} parallel`;
  else if (step?.ordinal != null) detail = `Step ${String(step.ordinal)}`;
  return (
    <div
      role="status"
      className="lens flex min-w-0 items-center gap-2 rounded-lg px-3 py-2"
    >
      <StatusMark tone={look.tone}>
        {overlay.run.cancelRequestedAt === null ? current : 'Stopping…'}
      </StatusMark>
      {detail === undefined ? null : <span>{detail}</span>}
    </div>
  );
}
