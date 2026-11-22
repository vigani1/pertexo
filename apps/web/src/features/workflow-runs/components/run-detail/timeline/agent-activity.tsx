import type { RunDataScope } from '../data/value';
import { StepModelUsage } from '../run-diagnostics';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatDurationMs } from '@/lib/format/time';
import { AGENT_SEND_SLACK_MESSAGE } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';
import type { RunTimelineRow } from '../../../model/timeline/runs';

const approvalLabels = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Approval rejected',
  expired: 'Approval expired',
  refused: 'Approval unavailable',
  canceled: 'Approval canceled',
} satisfies Record<NonNullable<RunTimelineRow['agentApproval']>, string>;

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
  const approvals = new Map(
    activity.flatMap(({ row, turn }) =>
      row.agentApproval === undefined
        ? []
        : [[turn, row.agentApproval] as const],
    ),
  );
  const executed = new Set(
    activity.filter(({ tool }) => tool).map(({ turn }) => turn),
  );
  const writeAllowed = rows.some(
    ({ key, agentWriteAllowed }) =>
      key === parentKey && agentWriteAllowed === true,
  );
  return (
    <section aria-label="Agent activity" className="mt-6">
      <h3 className="mb-2 text-xs font-semibold text-subtle-foreground">
        Agent activity
      </h3>
      <ol>
        {activity.map(({ row, tool, turn }) => (
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
            <ToolApproval
              allowed={tool && writeAllowed}
              approval={approvals.get(turn)}
              show={tool || !executed.has(turn)}
            />
            {row.definitionKey === AGENT_SEND_SLACK_MESSAGE.key &&
            row.dispatchMarkedAt !== undefined ? (
              <span className="basis-full text-muted-foreground">
                Dispatch recorded {formatDateTime(row.dispatchMarkedAt)}
              </span>
            ) : null}
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

function ToolApproval({
  allowed,
  approval,
  show,
}: Readonly<{
  allowed: boolean;
  approval: RunTimelineRow['agentApproval'];
  show: boolean;
}>) {
  if (!show) return null;
  if (approval !== undefined)
    return (
      <Status tone={approval === 'approved' ? 'success' : 'attention'}>
        {approvalLabels[approval]}
      </Status>
    );
  if (allowed)
    return (
      <span className="text-muted-foreground">Allowed without approval</span>
    );
  return null;
}
