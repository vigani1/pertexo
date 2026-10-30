import {
  parseCheckpoint,
  reconstructReadySet,
} from '../checkpoint/create-and-parse.js';
import { WorkflowEngineError } from '../errors.js';
import { pruneFinishedIterations } from './prune.js';
import { deriveReadyNodes } from './scheduling/readiness.js';
import { compareOrdinal } from '@pertexo/workflow-model';
import {
  assertNodeTransition,
  assertRunTransition,
  invocationIdentity,
} from './status.js';
import {
  boundedReadyAdmissions,
  deriveTerminalRunStatus,
} from './decisions.js';
import type {
  InvocationState,
  AttemptAdmissionPlan,
  NodeRunAdmissionPlan,
  WorkflowTransitionPlan,
} from '../types.js';
import {
  isTerminalNodeStatus,
  schedulerNodeSideEffectClass,
  scopedLoopSinkInvocation,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './state.js';

function hasUnsettledSchedulerWork(state: MutableWorkflowTransition): boolean {
  const { current, graph, invocations, branchSelections, loops } = state;
  const cannotDeriveReadiness =
    !graph?.deriveReadiness || state.cancelRequested || state.deadlineExpired;
  if (cannotDeriveReadiness) return false;
  const allInvocations = [...invocations.values()];
  if (
    deriveReadyNodes({
      graph,
      workflowVersionId: current.workflowVersionId,
      invocations: allInvocations,
      branchSelections,
    }).length > 0
  )
    return true;
  for (const loop of loops.values()) {
    if (loop.terminalStatus !== undefined) continue;
    const body = graph.structuredBodies?.find(
      ({ loopNodeId }) => loopNodeId === loop.loopId,
    );
    for (const ordinal of loop.activeOrdinals) {
      const sink = scopedLoopSinkInvocation(loop, ordinal, allInvocations);
      if (sink !== undefined && isTerminalNodeStatus(sink.status)) return true;
      if (
        body !== undefined &&
        deriveReadyNodes({
          graph: {
            deriveReadiness: true,
            nodes: body.nodes,
            edges: body.edges,
          },
          workflowVersionId: current.workflowVersionId,
          invocations: allInvocations,
          branchSelections,
          branchPath: loop.branchPath,
          iterationPath: [
            ...loop.iterationPath,
            { loopNodeId: loop.loopId, ordinal },
          ],
        }).length > 0
      )
        return true;
    }
  }
  return false;
}

export function buildWorkflowTransitionPlan(
  state: MutableWorkflowTransition,
  input: Readonly<{
    consumedObservationCount: number;
    consumedThroughEventSequence: number;
    maximumAdmissions: number;
    hasExecutionSlot: boolean;
    occurredAt: string;
  }>,
): WorkflowTransitionPlan {
  const {
    current,
    invocations,
    eventDrafts,
    nodeRunAdmissionKeys,
    cancelRequested,
    deadlineExpired,
  } = state;
  const ordered = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const readySet = ordered
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  const admittedKeys =
    cancelRequested || deadlineExpired || !input.hasExecutionSlot
      ? []
      : boundedReadyAdmissions({
          invocations: [...invocations.values()],
          maximumAdmissions: input.maximumAdmissions,
          readySet,
          schedulerNodes: state.schedulerNodes,
        });
  const attempts = admitAttempts(state, admittedKeys);
  if (state.runStatus === 'waiting' && attempts.length > 0) {
    assertRunTransition(state.runStatus, 'running');
    state.runStatus = 'running';
  }

  settleRunStatus(state, input);

  const firstDerivedEventSequence =
    current.nextEventSequence + input.consumedObservationCount;
  const events = eventDrafts.map((draft, offset) => ({
    ...draft,
    sequence: firstDerivedEventSequence + offset,
  }));
  const pruned = pruneFinishedIterations(state);
  const checkpoint = parseCheckpoint({
    ...current,
    revision: current.revision + 1,
    runStatus: state.runStatus,
    nextEventSequence: firstDerivedEventSequence + events.length,
    cancelRequested,
    deadlineExpired,
    joins: pruned.joins,
    loops: pruned.loops,
    ...(pruned.retiredIterationBudget === 0
      ? {}
      : { retiredIterationBudget: pruned.retiredIterationBudget }),
    remainingIterationBudget: state.remainingIterationBudget,
    admittedInvocationKeys: [
      ...new Set([...current.admittedInvocationKeys, ...admittedKeys]),
    ]
      .filter((key) => !pruned.prunedKeys.has(key))
      .sort(),
    invocations: pruned.invocations,
    readySet: reconstructReadySet({
      ...current,
      invocations: pruned.invocations,
    }),
    branchSelections: pruned.branchSelections,
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
        sideEffectClass: schedulerNodeSideEffectClass(
          state.schedulerNodes,
          invocation.nodeId,
        ),
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
    ...(state.failureValues.length === 0
      ? {}
      : { failureValues: state.failureValues }),
    ...(pruned.prunedInvocations.length === 0
      ? {}
      : { prunedInvocations: pruned.prunedInvocations }),
    ...(input.hasExecutionSlot &&
    attempts.length === 0 &&
    ['running', 'waiting'].includes(state.runStatus) &&
    hasUnsettledSchedulerWork(state)
      ? { immediateContinuation: true as const }
      : {}),
  };
}

function admitAttempts(
  state: MutableWorkflowTransition,
  admittedKeys: readonly string[],
): readonly AttemptAdmissionPlan[] {
  const { invocations } = state;
  const attempts: AttemptAdmissionPlan[] = [];
  for (const key of admittedKeys) {
    const invocation = invocations.get(key);
    if (invocation === undefined)
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `ready invocation ${key} is missing`,
      );
    assertNodeTransition(invocation.status, 'running');
    const admissionKind = attemptAdmissionKind(invocation.waitKind);
    const running = {
      ...invocationIdentity(invocation),
      status: 'running' as const,
      attemptNumber: invocation.attemptNumber + 1,
    };
    invocations.set(key, running);
    attempts.push({
      invocationKey: key,
      nodeId: running.nodeId,
      attemptNumber: running.attemptNumber,
      admissionKind,
      sideEffectClass: schedulerNodeSideEffectClass(
        state.schedulerNodes,
        running.nodeId,
      ),
      ...(running.branchPath === undefined
        ? {}
        : { branchPath: running.branchPath }),
      ...(running.iterationPath === undefined
        ? {}
        : { iterationPath: running.iterationPath }),
    });
  }
  return attempts;
}
function settleRunStatus(
  state: MutableWorkflowTransition,
  input: Parameters<typeof buildWorkflowTransitionPlan>[1],
): void {
  const { invocations, graph, cancelRequested, deadlineExpired, eventDrafts } =
    state;
  const finalInvocations = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const nonterminal = finalInvocations.filter(({ status }) =>
    ['pending', 'ready', 'running', 'waiting'].includes(status),
  );
  const graphIncomplete =
    graph?.nodes.some(
      ({ id }) => !finalInvocations.some(({ nodeId }) => nodeId === id),
    ) ?? false;
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
  } else {
    const allWorkWaiting =
      state.runStatus === 'running' &&
      nonterminal.length > 0 &&
      nonterminal.every(
        ({ status, invocationKey }) =>
          status === 'waiting' ||
          (status === 'pending' && state.joins.has(invocationKey)) ||
          (!input.hasExecutionSlot && status === 'ready'),
      );
    if (allWorkWaiting) {
      assertRunTransition(state.runStatus, 'waiting');
      state.runStatus = 'waiting';
      eventDrafts.push(event('run.waiting', input.occurredAt));
    }
  }
}
function attemptAdmissionKind(
  waitKind: InvocationState['waitKind'],
): AttemptAdmissionPlan['admissionKind'] {
  if (waitKind === 'node_wait') return 'wait_resume';
  if (waitKind === 'retry_backoff') return 'retry';
  return 'execute';
}
