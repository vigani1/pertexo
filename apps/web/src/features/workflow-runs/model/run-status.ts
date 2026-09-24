import type {
  WorkflowNodeRunSummary,
  WorkflowRunSummary,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { CoreOrbState } from '@/components/patterns/core-orb';
import type { StatusTone } from '@/components/ui/status';

export type RunStatus = WorkflowRunSummary['status'];
export type NodeStatus = WorkflowNodeRunSummary['status'];
export type RunTriggerType = WorkflowRunSummary['triggerType'];

export type StatusLook = Readonly<{ tone: StatusTone; label: string }>;

// One glyph, one colour, one word per run and step status. Every run surface
// (lists, loom, thread view, graph, lens) reads its tone from here.
const runStatusLooks: Readonly<Record<RunStatus, StatusLook>> = {
  queued: { tone: 'queued', label: 'Queued' },
  running: { tone: 'live', label: 'Running' },
  waiting: { tone: 'waiting', label: 'Waiting' },
  succeeded: { tone: 'success', label: 'Succeeded' },
  failed: { tone: 'failure', label: 'Failed' },
  canceled: { tone: 'canceled', label: 'Canceled' },
  timed_out: { tone: 'timeout', label: 'Timed out' },
  outcome_unknown: { tone: 'attention', label: 'Outcome unknown' },
};

const nodeStatusLooks: Readonly<Record<NodeStatus, StatusLook>> = {
  pending: { tone: 'queued', label: 'Pending' },
  ready: { tone: 'queued', label: 'Ready' },
  running: { tone: 'live', label: 'Running' },
  waiting: { tone: 'waiting', label: 'Waiting' },
  succeeded: { tone: 'success', label: 'Succeeded' },
  failed: { tone: 'failure', label: 'Failed' },
  skipped: { tone: 'skipped', label: 'Skipped' },
  canceled: { tone: 'canceled', label: 'Canceled' },
  timed_out: { tone: 'timeout', label: 'Timed out' },
  outcome_unknown: { tone: 'attention', label: 'Outcome unknown' },
};

const triggerLabels: Readonly<Record<RunTriggerType, string>> = {
  api: 'API',
  manual: 'Manual',
  replay: 'Replay',
  schedule: 'Schedule',
  webhook: 'Webhook',
};

export const runTriggerTypes: readonly RunTriggerType[] = [
  'manual',
  'webhook',
  'schedule',
  'api',
  'replay',
];

export const runStatuses: readonly RunStatus[] = [
  'running',
  'waiting',
  'queued',
  'succeeded',
  'failed',
  'timed_out',
  'outcome_unknown',
  'canceled',
];

const activeRunStatuses = new Set<RunStatus>(['queued', 'running', 'waiting']);

export function describeRunStatus(status: RunStatus): StatusLook {
  return runStatusLooks[status];
}

export function describeNodeStatus(status: NodeStatus): StatusLook {
  return nodeStatusLooks[status];
}

export function describeTrigger(type: RunTriggerType): string {
  return triggerLabels[type];
}

/** Queued, running or waiting: work that can still change. */
export function isActiveRunStatus(status: RunStatus): boolean {
  return activeRunStatuses.has(status);
}

/** The run's Core: colour and motion follow the run's state. */
export function runCoreState(status: RunStatus): CoreOrbState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'live';
    case 'waiting':
      return 'waiting';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'canceled':
    case 'outcome_unknown':
      return 'idle';
  }
}
