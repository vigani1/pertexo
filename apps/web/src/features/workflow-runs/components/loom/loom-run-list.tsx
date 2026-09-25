import { Link } from '@tanstack/react-router';
import { ChevronDownIcon } from 'lucide-react';
import { Status } from '@/components/ui/status';
import { formatClock, formatDurationMs } from '@/lib/format-time';
import type { LoomModel } from '../../model/loom';
import { describeRunStatus } from '../../model/run-status';

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
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3.5 transition-transform group-open:rotate-180"
        />
        List the {String(model.runCount)} runs on this timeline
        {model.hiddenLaneCount > 0
          ? ` (and ${String(model.hiddenLaneCount)} more workflows not drawn)`
          : ''}
      </summary>
      <div className="mt-3 grid gap-5 sm:grid-cols-2">
        {model.lanes.map((lane) => (
          <section key={lane.key} aria-label={lane.label} className="min-w-0">
            <h3 className="truncate font-sans text-sm font-semibold">
              {lane.label}
            </h3>
            {lane.total === undefined ? null : (
              <p className="font-mono text-xs text-subtle-foreground">
                {String(lane.total)} {lane.total === 1 ? 'run' : 'runs'} in{' '}
                {windowLabel}
              </p>
            )}
            <ul className="mt-1.5 flex flex-col">
              {[...lane.runs].reverse().map((run) => {
                const look = describeRunStatus(run.status);
                return (
                  <li key={run.id}>
                    <Link
                      to="/w/$workspaceId/runs/$runId"
                      params={{ workspaceId, runId: run.id }}
                      className="flex items-center justify-between gap-3 rounded-sm py-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
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
    </details>
  );
}
