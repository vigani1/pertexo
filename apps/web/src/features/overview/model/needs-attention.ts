import type {
  ConnectionResponse,
  PendingTaskSummary,
  FailureNotificationDestinationResponse,
  WorkflowSummary,
  WorkflowRunListItem,
} from '@pertexo/contracts';
import type { StatusTone } from '@/components/patterns/status/status-mark';
import { bySoonestDeadline } from '@/features/pending-tasks/public';
import { needsReconnecting } from '@/features/connections/public';
import { describeListedFailure } from '@/features/workflow-runs/public';
import { formatDateTime, formatElapsedTime } from '@/lib/format/time';
import { formatCount, pluralWord } from '@/lib/format/count';
import { ATTENTION_WINDOW_HOURS } from '@/features/workflow-runs/workflow-runs-queries.public';

export const ATTENTION_WINDOW = `the last ${formatCount(ATTENTION_WINDOW_HOURS, 'hour')}`;

// "Needs attention" is derived from reads the app already makes: problem
// runs from the last day, workflows whose triggers aren't healthy,
// connections to reconnect and alert destinations that are off.

export type AttentionAction =
  | Readonly<{ kind: 'task'; taskId: string }>
  | Readonly<{ kind: 'run'; runId: string; retryStep?: string }>
  | Readonly<{ kind: 'triggers'; workflowId: string }>
  | Readonly<{ kind: 'connections'; connectionId: string }>
  | Readonly<{ kind: 'alerts' }>;

export type AttentionItem = Readonly<{
  key: string;
  tone: StatusTone;
  title: string;
  detail: string;
  action?: AttentionAction;
  deadline?: string;
}>;

export function taskAttentionItems(
  tasks: readonly PendingTaskSummary[],
): readonly AttentionItem[] {
  return tasks
    .filter((task) => task.status === 'pending' && task.canRespond)
    .sort(bySoonestDeadline)
    .map((task) => ({
      key: `request:${task.id}`,
      tone: 'waiting',
      title: task.title,
      detail: task.workflowName,
      deadline: task.expiresAt,
      action: { kind: 'task', taskId: task.id },
    }));
}

export type ProblemRuns = Readonly<{
  failed: readonly WorkflowRunListItem[];
  timedOut: readonly WorkflowRunListItem[];
  outcomeUnknown: readonly WorkflowRunListItem[];
}>;

/** Each incident keeps its own status and recovery destination. */
export function runAttentionItems(
  runs: ProblemRuns,
  nowMs: number,
): readonly AttentionItem[] {
  return [
    ...runs.failed.map(
      (run) => ({ run, tone: 'failure', outcome: 'failed' }) as const,
    ),
    ...runs.timedOut.map(
      (run) => ({ run, tone: 'timeout', outcome: 'timed out' }) as const,
    ),
    ...runs.outcomeUnknown.map(
      (run) =>
        ({
          run,
          tone: 'attention',
          outcome: 'has an unknown outcome',
        }) as const,
    ),
  ]
    .sort((left, right) =>
      right.run.createdAt.localeCompare(left.run.createdAt),
    )
    .map(({ run, tone, outcome }) =>
      withRunFailure(
        {
          key: `run:${run.id}`,
          tone,
          title: `${run.workflowName ?? 'A workflow'} ${outcome}`,
          detail: formatElapsedTime(run.completedAt ?? run.updatedAt, nowMs),
          action: { kind: 'run', runId: run.id },
        },
        describeListedFailure(run.failedStep, run.failureReasonCode),
      ),
    );
}

export function withRunFailure(
  item: AttentionItem,
  failure: Readonly<{ step?: string; reason?: string }> | undefined,
): AttentionItem {
  if (failure === undefined) return item;
  const step = failure.step;
  return {
    ...item,
    title: step === undefined ? item.title : `${item.title} at ${step}`,
    detail:
      failure.reason === undefined
        ? item.detail
        : `${failure.reason} · ${item.detail}`,
    ...(item.action?.kind === 'run' &&
    item.tone === 'failure' &&
    step !== undefined
      ? { action: { ...item.action, retryStep: step } }
      : {}),
  };
}

/** Workflows whose triggers are degraded or stopped with an error. */
export function workflowAttentionItems(
  workflows: readonly WorkflowSummary[],
): readonly AttentionItem[] {
  return workflows.flatMap((workflow): AttentionItem[] => {
    if (workflow.lifecycleStatus === 'archived') return [];
    const action = { kind: 'triggers', workflowId: workflow.id } as const;
    if (workflow.activationStatus === 'degraded')
      return [
        {
          key: `workflow:${workflow.id}`,
          tone: 'attention',
          title: `${workflow.name} is degraded`,
          detail: 'Some of its triggers aren’t running.',
          action,
        },
      ];
    if (workflow.activationStatus === 'error')
      return [
        {
          key: `workflow:${workflow.id}`,
          tone: 'failure',
          title: `${workflow.name}’s triggers stopped`,
          detail: 'New runs won’t start until the trigger problem is fixed.',
          action,
        },
      ];
    return [];
  });
}

/** Connections that need someone to sign in to the provider again. */
export function connectionAttentionItems({
  connections,
  canManage,
}: Readonly<{
  connections: readonly ConnectionResponse[];
  canManage: boolean;
}>): readonly AttentionItem[] {
  return connections.filter(needsReconnecting).map((connection) => {
    const observed = connection.health.lastRunObservedAt;
    const impact = canManage
      ? 'Steps that use it fail until it’s reconnected.'
      : 'Steps that use it fail until an admin reconnects it.';
    return {
      key: `connection:${connection.id}`,
      tone: 'attention',
      title: `${connection.name} needs reconnecting`,
      detail:
        observed == null
          ? impact
          : `Last observed in a run ${formatDateTime(observed)}. ${impact}`,
      ...(canManage
        ? {
            action: {
              kind: 'connections',
              connectionId: connection.id,
            } as const,
          }
        : {}),
    };
  });
}

/** Failure alert destinations that are switched off. */
export function destinationAttentionItems(
  destinations: readonly FailureNotificationDestinationResponse[],
): readonly AttentionItem[] {
  const disabled = destinations.filter(
    (destination) => destination.status === 'disabled',
  );
  if (disabled.length === 0) return [];
  const kinds = [
    ...new Set(
      disabled.map((destination) =>
        destination.kind === 'slack' ? 'Slack' : 'email',
      ),
    ),
  ];
  return [
    {
      key: 'destinations:disabled',
      tone: 'attention',
      title: pluralWord(
        disabled.length,
        'A failure alert destination is turned off',
        `${String(disabled.length)} failure alert destinations are turned off`,
      ),
      detail: `Failures that should reach ${kinds.join(' and ')} won’t be sent.`,
      action: { kind: 'alerts' },
    },
  ];
}
