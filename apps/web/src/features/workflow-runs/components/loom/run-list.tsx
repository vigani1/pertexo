import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { formatClock, formatDurationMs } from '@/lib/format/time';
import type { LoomModel } from '../../model/loom/model';
import { describeRunStatus } from '../../model/presentation/run-status';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { Disclosure } from '@/components/ui/disclosure';

/**
 * The Loom's text alternative: every plotted run, per workflow, as a link.
 * Collapsed by default so it doesn't compete with the picture.
 */
export function LoomRunList({
  model,
  workspaceId,
  windowLabel,
}: Readonly<{ model: LoomModel; workspaceId: string; windowLabel: string }>) {
  if (model.runCount === 0) return null;
  return (
    <Disclosure
      summary={
        <>
          {model.runCount === 1
            ? 'List the run on this timeline'
            : `List the ${String(model.runCount)} runs on this timeline`}
          {model.hiddenLaneCount > 0
            ? ` (and ${String(model.hiddenLaneCount)} more ${model.hiddenLaneCount === 1 ? 'workflow' : 'workflows'} not drawn)`
            : ''}
        </>
      }
      size="xs"
    >
      <div className="mt-3 grid gap-5 sm:grid-cols-2">
        {model.lanes.map((lane) => (
          <section key={lane.key} aria-label={lane.label} className="min-w-0">
            <h3 className="truncate font-sans text-sm font-semibold">
              {lane.label}
            </h3>
            {lane.total === undefined ? null : (
              <p className="font-mono text-xs text-subtle-foreground">
                {lane.total.toLocaleString(FORMAT_LOCALE)}{' '}
                {lane.total === 1 ? 'run' : 'runs'} in {windowLabel}
              </p>
            )}
            <ul className="mt-1.5 flex flex-col">
              {[...lane.runs].reverse().map((run) => {
                const look = describeRunStatus({
                  status: run.status,
                  handledFailureCount: run.handledFailureCount,
                });
                return (
                  <li key={run.id}>
                    <Link
                      to="/w/$workspaceId/runs/$runId"
                      params={{ workspaceId, runId: run.id }}
                      className="flex items-center justify-between gap-3 rounded-sm py-1 text-muted-foreground hover:text-foreground focus-ring focus-visible:outline-none"
                    >
                      <Status tone={look.tone}>{look.label}</Status>
                      <span className="font-mono text-xs text-subtle-foreground">
                        {formatClock(run.createdAt)}
                        {run.endMs === null
                          ? ''
                          : ` · ${formatDurationMs(run.endMs - run.startMs)}`}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Disclosure>
  );
}
