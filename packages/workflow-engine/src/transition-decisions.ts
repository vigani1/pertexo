import {
  configuredParallelMaxConcurrency,
  type SchedulerState,
} from './graph-scheduler.js';
import type { InvocationState, WorkflowCheckpoint } from './types.js';
import { WorkflowEngineError } from './errors.js';

export function boundedReadyAdmissions(input: {
  readonly invocations: readonly InvocationState[];
  readonly maximumAdmissions: number;
  readonly readySet: readonly string[];
  readonly schedulerState: SchedulerState | undefined;
}): readonly string[] {
  if (input.schedulerState === undefined)
    return input.readySet.slice(0, input.maximumAdmissions);
  const nodeById = new Map<
    string,
    {
      readonly node: SchedulerState['nodes'][number];
      readonly containingLoopId?: string;
    }
  >(input.schedulerState.nodes.map((node) => [node.id, { node }]));
  for (const body of input.schedulerState.structuredBodies ?? []) {
    for (const node of body.nodes)
      nodeById.set(node.id, { node, containingLoopId: body.loopNodeId });
  }
  const invocationByKey = new Map(
    input.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const constraints = (invocation: InvocationState) =>
    (invocation.branchPath ?? []).flatMap((part, index) => {
      const owner = nodeById.get(part.nodeId);
      const limit = configuredParallelMaxConcurrency(owner?.node ?? {});
      if (limit === undefined) return [];
      const iterationPath = invocation.iterationPath ?? [];
      const containingLoopIndex =
        owner?.containingLoopId === undefined
          ? -1
          : iterationPath.findIndex(
              ({ loopNodeId }) => loopNodeId === owner.containingLoopId,
            );
      if (owner?.containingLoopId !== undefined && containingLoopIndex < 0)
        throw new WorkflowEngineError(
          'checkpoint_invalid',
          'Parallel invocation is missing its containing loop scope',
        );
      // A nested Parallel has a separate cap per enclosing iteration. A root
      // Parallel still shares its cap across any descendant loop iterations.
      const key = JSON.stringify([
        part.nodeId,
        (invocation.branchPath ?? [])
          .slice(0, index)
          .map(({ nodeId, outputPort }) => [nodeId, outputPort]),
        iterationPath
          .slice(0, containingLoopIndex + 1)
          .map(({ loopNodeId, ordinal }) => [loopNodeId, ordinal]),
      ]);
      return [{ key, limit }];
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
