import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import type { StatusTone } from '@/components/ui/status';
import { formatRelativeTime } from '@/lib/format-time';

// "Needs attention" is derived from reads the app already makes: problem
// runs from the last day, workflows whose triggers aren't healthy,
// connections to reconnect and alert destinations that are off.

export type AttentionAction =
  | Readonly<{ kind: 'run'; runId: string }>
  | Readonly<{ kind: 'triggers'; workflowId: string }>
  | Readonly<{ kind: 'connections' }>
  | Readonly<{ kind: 'alerts' }>;

export type AttentionItem = Readonly<{
  key: string;
  tone: StatusTone;
  title: string;
  detail: string;
  action?: AttentionAction;
}>;

export type ProblemRuns = Readonly<{
  failed: readonly WorkflowRunReadSummary[];
  timedOut: readonly WorkflowRunReadSummary[];
  outcomeUnknown: readonly WorkflowRunReadSummary[];
}>;

function times(count: number): string {
  if (count === 1) return 'once';
  if (count === 2) return 'twice';
  return `${String(count)} times`;
}

interface RunGroup {
  workflowId: string;
  name: string;
  failed: number;
  timedOut: number;
  unknown: number;
  latest: WorkflowRunReadSummary;
}

function groupTitle(group: RunGroup): string {
  const total = group.failed + group.timedOut + group.unknown;
  if (group.failed === total)
    return `${group.name} failed ${times(total)} in the last 24 hours`;
  if (group.timedOut === total)
    return `${group.name} timed out ${times(total)} in the last 24 hours`;
  if (group.unknown === total)
    return total === 1
      ? `${group.name} has a run with an unknown outcome`
      : `${group.name} has ${String(total)} runs with an unknown outcome`;
  return `${group.name} had ${String(total)} runs go wrong in the last 24 hours`;
}

function groupDetail(group: RunGroup, nowMs: number): string {
  const parts = [
    group.failed > 0 ? `${String(group.failed)} failed` : undefined,
    group.timedOut > 0 ? `${String(group.timedOut)} timed out` : undefined,
    group.unknown > 0 ? `${String(group.unknown)} unknown` : undefined,
  ].filter((part): part is string => part !== undefined);
  const latest = `latest ${formatRelativeTime(group.latest.createdAt, nowMs)}`;
  return parts.length > 1 ? `${parts.join(', ')} · ${latest}` : latest;
}

function groupTone(group: RunGroup): StatusTone {
  if (group.unknown > 0) return 'attention';
  return group.failed > 0 ? 'failure' : 'timeout';
}

/** Problem runs from the last day, one item per workflow, newest first. */
export function runAttentionItems(
  runs: ProblemRuns,
  nowMs: number,
): readonly AttentionItem[] {
  const groups = new Map<string, RunGroup>();
  const add = (
    run: WorkflowRunReadSummary,
    kind: 'failed' | 'timedOut' | 'unknown',
  ) => {
    const group = groups.get(run.workflowId) ?? {
      workflowId: run.workflowId,
      name: run.workflowName ?? 'A workflow',
      failed: 0,
      timedOut: 0,
      unknown: 0,
      latest: run,
    };
    group[kind] += 1;
    if (run.createdAt > group.latest.createdAt) group.latest = run;
    groups.set(run.workflowId, group);
  };
  for (const run of runs.failed) add(run, 'failed');
  for (const run of runs.timedOut) add(run, 'timedOut');
  for (const run of runs.outcomeUnknown) add(run, 'unknown');
  return [...groups.values()]
    .sort((left, right) =>
      right.latest.createdAt.localeCompare(left.latest.createdAt),
    )
    .map((group) => ({
      key: `runs:${group.workflowId}`,
      tone: groupTone(group),
      title: groupTitle(group),
      detail: groupDetail(group, nowMs),
      action: { kind: 'run', runId: group.latest.id },
    }));
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
export function connectionAttentionItems(
  connections: readonly ConnectionResponse[],
  canManage: boolean,
): readonly AttentionItem[] {
  return connections
    .filter((connection) => connection.status === 'reauthorization_required')
    .map((connection) => ({
      key: `connection:${connection.id}`,
      tone: 'attention',
      title: `${connection.name} needs reconnecting`,
      detail: canManage
        ? 'Steps that use it fail until it’s reconnected.'
        : 'Steps that use it fail until an admin reconnects it.',
      ...(canManage ? { action: { kind: 'connections' } as const } : {}),
    }));
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
      title:
        disabled.length === 1
          ? 'A failure alert destination is turned off'
          : `${String(disabled.length)} failure alert destinations are turned off`,
      detail: `Failures that should reach ${kinds.join(' and ')} won’t be sent.`,
      action: { kind: 'alerts' },
    },
  ];
}
