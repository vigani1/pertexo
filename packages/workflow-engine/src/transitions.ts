import { WorkflowEngineError } from './errors.js';
import type { AttemptStatus, NodeStatus, RunStatus } from './types.js';

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'canceled', 'timed_out'],
  running: [
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ],
  waiting: [
    'running',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ],
  succeeded: [],
  failed: [],
  canceled: [],
  timed_out: [],
  outcome_unknown: [],
};

const NODE_TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  pending: ['ready', 'skipped', 'canceled'],
  ready: ['running', 'skipped', 'canceled'],
  running: [
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ],
  waiting: ['ready', 'canceled', 'timed_out', 'outcome_unknown'],
  succeeded: [],
  failed: [],
  skipped: [],
  canceled: [],
  timed_out: [],
  outcome_unknown: [],
};

const ATTEMPT_TRANSITIONS: Readonly<
  Record<AttemptStatus, readonly AttemptStatus[]>
> = {
  pending: ['ready', 'canceled'],
  ready: ['running', 'canceled'],
  running: ['succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'],
  succeeded: [],
  failed: [],
  canceled: [],
  timed_out: [],
  outcome_unknown: [],
};

function assertTransition<T extends string>(
  aggregate: string,
  transitions: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): void {
  if (!transitions[from].includes(to)) {
    throw new WorkflowEngineError(
      'transition_invalid',
      `${aggregate} cannot transition ${from} -> ${to}`,
    );
  }
}

export const assertRunTransition = (from: RunStatus, to: RunStatus): void => {
  assertTransition('run', RUN_TRANSITIONS, from, to);
};

export const assertNodeTransition = (
  from: NodeStatus,
  to: NodeStatus,
): void => {
  assertTransition('node', NODE_TRANSITIONS, from, to);
};

export const assertAttemptTransition = (
  from: AttemptStatus,
  to: AttemptStatus,
): void => {
  assertTransition('attempt', ATTEMPT_TRANSITIONS, from, to);
};
