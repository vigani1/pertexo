import {
  configuredParallelMaxConcurrency,
  type SchedulerState,
} from './graph-scheduler.js';
import type { InvocationState, WorkflowCheckpoint } from './types.js';

export function boundedReadyAdmissions(input: {
  readonly invocations: readonly InvocationState[];
  readonly maximumAdmissions: number;
  readonly readySet: readonly string[];
  readonly schedulerState: SchedulerState | undefined;
}): readonly string[] {
  if (input.schedulerState === undefined)
    return input.readySet.slice(0, input.maximumAdmissions);
  const nodeById = new Map(
    input.schedulerState.nodes.map((node) => [node.id, node]),
  );
  const invocationByKey = new Map(
    input.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const constraints = (invocation: InvocationState) =>
    (invocation.branchPath ?? []).flatMap((part, index) => {
      const limit = configuredParallelMaxConcurrency(
        nodeById.get(part.nodeId) ?? {},
      );
      if (limit === undefined) return [];
      const parentScope = (invocation.branchPath ?? [])
        .slice(0, index)
        .map(({ nodeId, outputPort }) => `${nodeId}:${outputPort}`)
        .join('/');
      return [{ key: `${parentScope}\u0000${part.nodeId}`, limit }];
    });
  const active = new Map<string, number>();
  for (const invocation of input.invocations) {
    if (invocation.status !== 'running') continue;
    for (const { key } of constraints(invocation))
      active.set(key, (active.get(key) ?? 0) + 1);
  }
  const admitted: string[] = [];
  for (const key of input.readySet) {
    if (admitted.length >= input.maximumAdmissions) break;
    const invocation = invocationByKey.get(key);
    if (invocation === undefined) continue;
    const limits = constraints(invocation);
    if (limits.some(({ key, limit }) => (active.get(key) ?? 0) >= limit))
      continue;
    admitted.push(key);
    for (const { key } of limits) active.set(key, (active.get(key) ?? 0) + 1);
  }
  return admitted;
}

export function deriveTerminalRunStatus(input: {
  readonly cancelRequested: boolean;
  readonly deadlineExpired: boolean;
  readonly graphIncomplete: boolean;
  readonly invocations: readonly InvocationState[];
}):
  | Extract<
      WorkflowCheckpoint['runStatus'],
      'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown'
    >
  | undefined {
  const statuses = new Set(input.invocations.map(({ status }) => status));
  if (statuses.has('outcome_unknown')) return 'outcome_unknown';
  if (input.cancelRequested) return 'canceled';
  if (input.deadlineExpired) return 'timed_out';
  if (statuses.has('timed_out')) return 'timed_out';
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('canceled')) return 'canceled';
  if (
    input.invocations.length > 0 &&
    !input.graphIncomplete &&
    [...statuses].every(
      (status) => status === 'succeeded' || status === 'skipped',
    )
  )
    return 'succeeded';
  return undefined;
}
