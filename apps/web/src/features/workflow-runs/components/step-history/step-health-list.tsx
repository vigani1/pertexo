import type {
  AccessibleWorkspace,
  WorkflowStepHealth,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { formatDurationMs, formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { describeNodeStatus } from '../../model/run-status';
import { stepHealthQueryOptions } from '../../workflow-runs.queries';

/** The steps that fail most come first, then the slowest. */
function worstFirst(
  left: WorkflowStepHealth,
  right: WorkflowStepHealth,
): number {
  return (
    right.failed / right.runs - left.failed / left.runs ||
    (right.p95DurationMs ?? 0) - (left.p95DurationMs ?? 0)
  );
}

function duration(ms: number | null): string {
  return ms === null ? '—' : formatDurationMs(ms);
}

/**
 * Every step that ran in the workflow's last 100 runs, the ones that fail
 * most first: how often it ran and failed, how long it usually and at worst
 * takes, and how it ended last time (ADR 051). `labelOf` names a step from
 * the workflow's graph; a step no longer in it says so.
 */
export function StepHealthList({
  apiClient,
  userId,
  workspace,
  workflowId,
  labelOf,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  labelOf: (nodeId: string) => string | undefined;
}>) {
  const canRead = workspace.capabilities.includes('run:read');
  const health = useQuery({
    ...stepHealthQueryOptions(apiClient, userId, workspace.id, workflowId),
    enabled: canRead,
  });
  if (!canRead)
    return (
      <p className="text-sm text-muted-foreground">
        Your role can’t see runs, so step health is hidden.
      </p>
    );
  if (health.isError)
    return (
      <p className="text-sm text-muted-foreground">
        Step health couldn’t be loaded. Try again in a moment.
      </p>
    );
  if (health.data === undefined)
    return (
      <div role="status" aria-label="Loading step health">
        <Skeleton className="h-20 w-full" />
      </div>
    );
  const { runsConsidered, oldestRunAt } = health.data;
  if (runsConsidered === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This workflow hasn’t run yet. Once it does, each step’s record shows
        here.
      </p>
    );
  const items = [...health.data.items].sort(worstFirst);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs text-subtle-foreground">
        last {String(runsConsidered)} runs
        {oldestRunAt === null
          ? ''
          : ` · since ${formatRelativeTime(oldestRunAt)}`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-mono text-[0.7rem] text-subtle-foreground">
              <th className="py-1.5 pr-3 font-normal">Step</th>
              <th className="px-3 py-1.5 text-right font-normal">Ran</th>
              <th className="px-3 py-1.5 text-right font-normal">Failed</th>
              <th className="hidden px-3 py-1.5 text-right font-normal sm:table-cell">
                Usually
              </th>
              <th className="hidden px-3 py-1.5 text-right font-normal sm:table-cell">
                Slowest
              </th>
              <th className="py-1.5 pl-3 font-normal">Last</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const look = describeNodeStatus(item.lastStatus);
              const label = labelOf(item.nodeId);
              return (
                <tr key={item.nodeId} className="border-t border-white/6">
                  <td className="max-w-[14rem] truncate py-2 pr-3">
                    {label ?? (
                      <span className="text-muted-foreground">
                        A removed step
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {String(item.runs)}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono tabular-nums',
                      item.failed > 0 && 'text-destructive',
                    )}
                  >
                    {String(item.failed)}
                  </td>
                  <td className="hidden px-3 py-2 text-right font-mono tabular-nums sm:table-cell">
                    {duration(item.medianDurationMs)}
                  </td>
                  <td className="hidden px-3 py-2 text-right font-mono tabular-nums sm:table-cell">
                    {duration(item.p95DurationMs)}
                  </td>
                  <td className="py-2 pl-3">
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <StatusGlyph tone={look.tone} />
                      <span className="sr-only">{look.label}</span>
                      <span className="font-mono text-xs text-subtle-foreground">
                        {formatRelativeTime(item.lastRanAt)}
                      </span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
