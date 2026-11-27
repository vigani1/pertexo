import { Link } from '@tanstack/react-router';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { describeRunStatus } from '@/features/workflow-runs/public';
import { formatClock } from '@/lib/format/time';
import { useEditorSession } from '../../model/state/context';
import type { LastRunOverlay } from '../../model/canvas/last-run';

/**
 * The line above the canvas that says which run the results under the
 * steps come from, links to it and hides or shows them. Nothing before a
 * workflow's first run.
 */
export function LastRunLine({
  overlay,
  shown,
  onToggle,
}: Readonly<{
  overlay: LastRunOverlay | undefined;
  shown: boolean;
  onToggle: () => void;
}>) {
  const { scope } = useEditorSession();
  if (overlay === undefined) return null;
  const { run } = overlay;
  const look = describeRunStatus({ status: run.status });
  return (
    <p className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-caption text-subtle-foreground">
      <StatusMark tone={look.tone}>
        {look.label} · last run {formatClock(run.createdAt)}
      </StatusMark>
      {shown ? (
        <span className="max-xl:hidden">
          Under each step: what it did in that run
        </span>
      ) : null}
      <Link
        to="/w/$workspaceId/runs/$runId"
        params={{ workspaceId: scope.workspace.id, runId: run.id }}
        className="text-glint hover:underline focus-ring rounded-xs"
      >
        Open run
      </Link>
      <button
        type="button"
        className="rounded-xs hover:text-foreground focus-ring"
        onClick={onToggle}
      >
        {shown ? 'Hide results' : 'Show results'}
      </button>
    </p>
  );
}
