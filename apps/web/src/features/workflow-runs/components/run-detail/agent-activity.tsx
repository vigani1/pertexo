import type { RunDataScope } from './data/value';
import { StepModelUsage } from './run-diagnostics';
import { Status } from '@/components/ui/status';
import { formatDurationMs } from '@/lib/format/time';
import { formatCount } from '@/lib/format/count';
import type { RunTimelineRow } from '../../model/timeline/runs';

export function AgentActivity({
  parentKey,
  rows,
  nowMs,
  scope,
  onSelectStep,
}: Readonly<{
  parentKey: string;
  rows: readonly RunTimelineRow[];
  nowMs: number;
  scope: RunDataScope;
  onSelectStep: (key: string) => void;
}>) {
  const activity = rows
    .flatMap((row) =>
      row.agentWork?.parentInvocationKey === parentKey
        ? [
            {
              row,
              turn: row.agentWork.turn,
              tool: row.agentWork.work.kind === 'tool_call',
            },
          ]
        : [],
    )
    .sort(
      (left, right) =>
        left.turn - right.turn || Number(left.tool) - Number(right.tool),
    );
  if (activity.length === 0) return null;
  return (
    <section aria-label="Agent activity" className="mt-6">
      <h3 className="mb-2 text-xs font-semibold text-subtle-foreground">
        Agent activity
      </h3>
      <ol>
        {activity.map(({ row, tool }) => (
          <li
            key={row.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2 text-xs"
          >
            <button
              type="button"
              className="text-action underline underline-offset-4 focus-ring"
              onClick={() => {
                onSelectStep(row.key);
              }}
            >
              {row.label}
            </button>
            <Status tone={row.tone}>{row.statusLabel}</Status>
            {row.startedAt === undefined ? null : (
              <span>
                {formatDurationMs(
                  (row.completedAt === undefined
                    ? nowMs
                    : Date.parse(row.completedAt)) - Date.parse(row.startedAt),
                )}
              </span>
            )}
            {row.attempts > 1 ? (
              <span>{formatCount(row.attempts - 1, 'retry', 'retries')}</span>
            ) : null}
            {!tool &&
            row.nodeRunId !== undefined &&
            row.currentAttemptNumber !== undefined &&
            row.attempts > 0 &&
            row.completedAt !== undefined ? (
              <div className="basis-full">
                <StepModelUsage
                  scope={scope}
                  nodeRunId={row.nodeRunId}
                  attemptNumber={row.currentAttemptNumber}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
