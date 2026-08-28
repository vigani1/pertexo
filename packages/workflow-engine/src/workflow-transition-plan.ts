import { parseCheckpoint, reconstructReadySet } from './checkpoint.js';
import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import { assertNodeTransition, assertRunTransition } from './transitions.js';
import {
  boundedReadyAdmissions,
  deriveTerminalRunStatus,
} from './transition-decisions.js';
import type {
  AttemptAdmissionPlan,
  NodeRunAdmissionPlan,
  WorkflowTransitionPlan,
} from './types.js';
import {
  schedulerNodeSideEffectClass,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

export function buildWorkflowTransitionPlan(
  state: MutableWorkflowTransition,
  input: Readonly<{
    consumedObservationCount: number;
    consumedThroughEventSequence: number;
    maximumAdmissions: number;
    occurredAt: string;
  }>,
): WorkflowTransitionPlan {
  const {
    current,
    graph,
    invocations,
    branchSelections,
    eventDrafts,
    nodeRunAdmissionKeys,
    cancelRequested,
    deadlineExpired,
    joins,
    loops,
  } = state;
  const ordered = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const readySet = ordered
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  const admittedKeys =
    cancelRequested || deadlineExpired
      ? []
      : boundedReadyAdmissions({
          invocations: [...invocations.values()],
          maximumAdmissions: input.maximumAdmissions,
          readySet,
          schedulerState: graph,
        });
  const attempts: AttemptAdmissionPlan[] = [];
  for (const key of admittedKeys) {
    const invocation = invocations.get(key);
    if (invocation === undefined)
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `ready invocation ${key} is missing`,
      );
    assertNodeTransition(invocation.status, 'running');
    const admissionKind =
      invocation.waitKind === 'node_wait'
        ? ('wait_resume' as const)
        : invocation.waitKind === 'retry_backoff'
          ? ('retry' as const)
          : ('execute' as const);
    const { waitKind: _waitKind, ...withoutWaitKind } = invocation;
    void _waitKind;
    const running = {
      ...withoutWaitKind,
      status: 'running' as const,
      attemptNumber: invocation.attemptNumber + 1,
    };
    invocations.set(key, running);
    attempts.push({
      invocationKey: key,
      nodeId: running.nodeId,
      attemptNumber: running.attemptNumber,
      admissionKind,
      sideEffectClass: schedulerNodeSideEffectClass(graph, running.nodeId),
      ...(running.branchPath === undefined
        ? {}
        : { branchPath: running.branchPath }),
      ...(running.iterationPath === undefined
        ? {}
        : { iterationPath: running.iterationPath }),
    });
  }

  const finalInvocations = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const nonterminal = finalInvocations.filter(({ status }) =>
    ['pending', 'ready', 'running', 'waiting'].includes(status),
  );
  const graphIncomplete =
    graph?.nodes.some(
      ({ id }) => !finalInvocations.some(({ nodeId }) => nodeId === id),
    ) === true;
  const runIsActive =
    state.runStatus === 'queued' ||
    state.runStatus === 'running' ||
    state.runStatus === 'waiting';
  if (runIsActive && nonterminal.length === 0) {
    const terminalStatus = deriveTerminalRunStatus({
      cancelRequested,
      deadlineExpired,
      graphIncomplete,
      invocations: finalInvocations,
    });
    if (terminalStatus !== undefined) {
      assertRunTransition(state.runStatus, terminalStatus);
      state.runStatus = terminalStatus;
      eventDrafts.push(event(`run.${terminalStatus}`, input.occurredAt));
    }
  } else if (
    state.runStatus === 'running' &&
    nonterminal.length > 0 &&
    nonterminal.every(({ status }) => status === 'waiting')
  ) {
    assertRunTransition(state.runStatus, 'waiting');
    state.runStatus = 'waiting';
    eventDrafts.push(event('run.waiting', input.occurredAt));
  }

  const firstDerivedEventSequence =
    current.nextEventSequence + input.consumedObservationCount;
  const events = eventDrafts.map((draft, offset) => ({
    ...draft,
    sequence: firstDerivedEventSequence + offset,
  }));
  const checkpoint = parseCheckpoint({
    ...current,
    revision: current.revision + 1,
    runStatus: state.runStatus,
    nextEventSequence: firstDerivedEventSequence + events.length,
    cancelRequested,
    deadlineExpired,
    joins: [...joins.values()],
    loops: [...loops.values()],
    remainingIterationBudget: state.remainingIterationBudget,
    admittedInvocationKeys: [
      ...new Set([...current.admittedInvocationKeys, ...admittedKeys]),
    ].sort(),
    invocations: finalInvocations,
    readySet: reconstructReadySet({
      ...current,
      invocations: finalInvocations,
    }),
    ...(current.schemaVersion === 2 ? { branchSelections } : {}),
  });
  const nodeRunAdmissions: NodeRunAdmissionPlan[] = [...nodeRunAdmissionKeys]
    .sort(compareOrdinal)
    .map((invocationKey) => {
      const invocation = invocations.get(invocationKey);
      if (invocation === undefined)
        throw new WorkflowEngineError(
          'checkpoint_invalid',
          `materialized invocation ${invocationKey} is missing`,
        );
      return {
        invocationKey,
        nodeId: invocation.nodeId,
        sideEffectClass: schedulerNodeSideEffectClass(graph, invocation.nodeId),
        ...(invocation.branchPath === undefined
          ? {}
          : { branchPath: invocation.branchPath }),
        ...(invocation.iterationPath === undefined
          ? {}
          : { iterationPath: invocation.iterationPath }),
      };
    });
  return {
    expectedRevision: current.revision,
    expectedNextEventSequence: current.nextEventSequence,
    consumedThroughEventSequence: input.consumedThroughEventSequence,
    checkpoint,
    events,
    nodeRunAdmissions,
    attempts,
  };
}
