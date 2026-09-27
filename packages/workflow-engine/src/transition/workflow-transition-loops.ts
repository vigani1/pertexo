import { WorkflowEngineError } from '../errors.js';
import {
  completeLoopIteration,
  createLoopState,
  invocationKey as createInvocationKey,
} from './scheduling.js';
import { sameOutputReference } from '../output-reference.js';
import { assertNodeTransition } from './transitions.js';
import type {
  InvocationState,
  LoopState,
  WorkflowObservation,
} from '../types.js';
import {
  isTerminalNodeStatus,
  nodeEventName,
  rootInvocationKey,
  sameLoopDeclaration,
  scopedLoopSinkInvocation,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

export function applyLoopStart(
  state: MutableWorkflowTransition,
  observation: Extract<WorkflowObservation, { kind: 'loop_started' }>,
  occurredAt: string,
): void {
  if (state.cancelRequested) return;
  if (
    state.current.schemaVersion === 1 &&
    (observation.controlInvocationKey !== undefined ||
      observation.branchPath !== undefined ||
      observation.iterationPath !== undefined ||
      observation.bodyRootNodeIds !== undefined ||
      observation.bodySinkNodeId !== undefined)
  )
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'structured For Each requires checkpoint V2',
    );
  const controlInvocationKey =
    observation.controlInvocationKey ??
    rootInvocationKey(state.current.workflowVersionId, observation.loopId);
  const existingLoop = state.loops.get(controlInvocationKey);
  if (existingLoop !== undefined) {
    const declared = createLoopState({
      ...observation,
      controlInvocationKey,
      remainingIterationBudget: Math.max(
        state.remainingIterationBudget,
        observation.collectionSize,
      ),
    });
    if (!sameLoopDeclaration(existingLoop, declared))
      throw new WorkflowEngineError(
        'loop_state_invalid',
        `loop ${observation.loopId} conflicts with its declaration`,
      );
    return;
  }
  let declared: LoopState;
  try {
    declared = createLoopState({
      ...observation,
      controlInvocationKey,
      remainingIterationBudget: state.remainingIterationBudget,
    });
  } catch (error) {
    if (
      !(error instanceof WorkflowEngineError) ||
      error.code !== 'loop_limit_exceeded'
    )
      throw error;
    const control = state.invocations.get(controlInvocationKey);
    if (control?.status !== 'running')
      throw new WorkflowEngineError(
        'loop_state_invalid',
        'For Each control is not running',
      );
    const failed = { ...control, status: 'failed' as const };
    state.invocations.set(controlInvocationKey, failed);
    state.eventDrafts.push(
      event('node.failed', occurredAt, failed, 'loop_limit_exceeded'),
    );
    return;
  }
  state.loops.set(declared.controlInvocationKey, declared);
  state.remainingIterationBudget -= declared.collectionSize;
  if (!state.invocations.has(controlInvocationKey)) {
    state.invocations.set(controlInvocationKey, {
      invocationKey: controlInvocationKey,
      nodeId: observation.loopId,
      status: 'pending',
      attemptNumber: 0,
    });
    state.nodeRunAdmissionKeys.add(controlInvocationKey);
    return;
  }
  const control = state.invocations.get(controlInvocationKey);
  if (control?.status !== 'running')
    throw new WorkflowEngineError(
      'loop_state_invalid',
      'For Each control is not running',
    );
  assertNodeTransition(control.status, 'waiting');
  state.invocations.set(controlInvocationKey, {
    ...control,
    status: 'waiting',
    output: observation.collection,
  });
}

export function applyLoopCompletion(
  state: MutableWorkflowTransition,
  observation: Extract<
    WorkflowObservation,
    { kind: 'loop_iteration_completed' }
  >,
  occurredAt: string,
): void {
  const loop =
    observation.controlInvocationKey === undefined
      ? [...state.loops.values()].find(
          ({ loopId }) => loopId === observation.loopId,
        )
      : state.loops.get(observation.controlInvocationKey);
  if (loop === undefined)
    throw new WorkflowEngineError(
      'loop_state_invalid',
      `loop ${observation.loopId} is not declared`,
    );
  const iterationPath = [
    ...loop.iterationPath,
    { loopNodeId: loop.loopId, ordinal: observation.ordinal },
  ];
  const iterationKey =
    observation.invocationKey ??
    scopedLoopSinkInvocation(
      loop,
      observation.ordinal,
      state.invocations.values(),
    )?.invocationKey ??
    createInvocationKey({
      workflowVersionId: state.current.workflowVersionId,
      nodeId: loop.bodySinkNodeId,
      branchPath: loop.branchPath.map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      ),
      iterationPath,
    });
  const iteration = state.invocations.get(iterationKey);
  if (iteration === undefined)
    throw new WorkflowEngineError(
      'loop_state_invalid',
      `loop sink ${iterationKey} has no invocation`,
    );
  const status = observation.status ?? 'succeeded';
  if (loop.terminalOrdinals.includes(observation.ordinal)) {
    if (
      iteration.status === status &&
      sameOutputReference(iteration.output, observation.output)
    )
      return;
    assertNodeTransition(iteration.status, status);
    return;
  }
  if (!isTerminalNodeStatus(iteration.status))
    assertNodeTransition(iteration.status, status);
  else if (iteration.status !== status)
    assertNodeTransition(iteration.status, status);
  const completedInvocation: InvocationState = {
    ...iteration,
    status,
    ...(observation.output === undefined ? {} : { output: observation.output }),
  };
  state.invocations.set(iterationKey, completedInvocation);
  const completedLoop = completeLoopIteration(loop, observation.ordinal);
  state.loops.set(
    loop.controlInvocationKey,
    status === 'succeeded' || status === 'skipped'
      ? completedLoop
      : {
          ...completedLoop,
          terminalStatus: loop.terminalStatus ?? status,
        },
  );
  if (
    status !== 'succeeded' &&
    status !== 'skipped' &&
    loop.terminalStatus === undefined
  ) {
    const control = state.invocations.get(loop.controlInvocationKey);
    if (control === undefined || isTerminalNodeStatus(control.status))
      throw new WorkflowEngineError(
        'loop_state_invalid',
        'For Each control cannot accept its first terminal cause',
      );
    assertNodeTransition(control.status, status);
    const stopped = { ...control, status };
    state.invocations.set(control.invocationKey, stopped);
    state.eventDrafts.push(
      event(
        nodeEventName[status] ?? 'node.failed',
        occurredAt,
        stopped,
        observation.reasonCode,
      ),
    );
  }
  const eventName = nodeEventName[status];
  if (eventName === undefined)
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `missing event mapping for ${status}`,
    );
  if (!state.externalFactsArePersisted)
    state.eventDrafts.push(
      event(eventName, occurredAt, completedInvocation, observation.reasonCode),
    );
}
