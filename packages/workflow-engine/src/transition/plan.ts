import { agentToolForAlias } from '../compilation/agent-tools.js';
import { graphInvocationsWithRoutedFailures } from '../failure-routing/scope.js';
import type { InlineAttemptSettlement } from '../attempt/inline-settlement.types.js';
import {
  parseCheckpoint,
  reconstructReadySet,
} from '../checkpoint/create-and-parse.js';
import { WorkflowEngineError } from '../workflow-engine.errors.js';
import { pruneFinishedIterations } from './prune.js';
import { reserveAgentAttempt } from './scheduling/agents.js';
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
} from '../workflow-execution.js';
import {
  isTerminalNodeStatus,
  schedulerAttemptSideEffectClass,
  schedulerNodeSideEffectClass,
  scopedLoopSinkInvocation,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './transition-state.js';

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
    inlineAttempts?: readonly InlineAttemptSettlement[];
    attemptKeys?: readonly string[];
    yieldInline?: boolean;
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
  const admittedKeys = input.yieldInline
    ? []
    : (input.attemptKeys ??
      selectReadyAdmissions(
        state,
        input.maximumAdmissions,
        input.hasExecutionSlot,
      ));
  const attempts = admitAttempts(state, admittedKeys, input.occurredAt);
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
      ...new Set([
        ...current.admittedInvocationKeys,
        ...attempts.map(({ invocationKey }) => invocationKey),
        ...(input.inlineAttempts ?? []).map(
          ({ invocationKey }) => invocationKey,
        ),
      ]),
    ]
      .filter((key) => !pruned.prunedKeys.has(key))
      .sort(),
    invocations: pruned.invocations,
    ...(state.agents.size === 0
      ? {}
      : {
          agents: [...state.agents.values()].filter(
            ({ parentInvocationKey }) =>
              !pruned.prunedKeys.has(parentInvocationKey),
          ),
        }),
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
        sideEffectClass:
          agentToolSideEffectClass(state, invocation) ??
          schedulerNodeSideEffectClass(state.schedulerNodes, invocation.nodeId),
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
    ...(state.agentTaskIntents.length === 0
      ? {}
      : { taskIntents: state.agentTaskIntents }),
    ...(state.agentOutputs.size === 0
      ? {}
      : {
          agentOutputs: [...state.agentOutputs].map(
            ([invocationKey, output]) => ({
              invocationKey,
              ...output,
            }),
          ),
        }),
    ...(input.inlineAttempts?.length
      ? { inlineAttempts: input.inlineAttempts }
      : {}),
    ...(state.failureValues.length === 0
      ? {}
      : { failureValues: state.failureValues }),
    ...(pruned.prunedInvocations.length === 0
      ? {}
      : { prunedInvocations: pruned.prunedInvocations }),
    ...(input.hasExecutionSlot &&
    attempts.length === 0 &&
    ['running', 'waiting'].includes(state.runStatus) &&
    (input.yieldInline ||
      state.continueAgents ||
      hasUnsettledSchedulerWork(state))
      ? { immediateContinuation: true as const }
      : {}),
  };
}

export function selectReadyAdmissions(
  state: MutableWorkflowTransition,
  maximumAdmissions: number,
  hasExecutionSlot: boolean,
): readonly string[] {
  const { invocations, cancelRequested, deadlineExpired } = state;
  const ordered = [...invocations.values()].sort((left, right) =>
    compareOrdinal(left.invocationKey, right.invocationKey),
  );
  const readySet = ordered
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  return cancelRequested || deadlineExpired || !hasExecutionSlot
    ? []
    : boundedReadyAdmissions({
        invocations: [...invocations.values()],
        maximumAdmissions: maximumAdmissions,
        readySet,
        schedulerNodes: state.schedulerNodes,
      });
}

export function admitAttempts(
  state: MutableWorkflowTransition,
  admittedKeys: readonly string[],
  occurredAt: string,
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
    if (!reserveAgentAttempt(state, invocation, occurredAt)) continue;
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
      sideEffectClass:
        agentToolSideEffectClass(state, running) ??
        schedulerAttemptSideEffectClass(state.schedulerNodes, running.nodeId),
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
function agentToolSideEffectClass(
  state: MutableWorkflowTransition,
  invocation: InvocationState,
) {
  if (invocation.agentWork?.work.kind !== 'tool_call') return undefined;
  return agentToolForAlias(
    state.agentScheduler?.tools.get(invocation.nodeId) ?? [],
    invocation.agentWork.toolAlias,
  )?.node.sideEffectClass;
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
      invocations: [
        ...graphInvocationsWithRoutedFailures(finalInvocations),
        ...finalInvocations.filter(
          ({ agentWork, status }) =>
            agentWork !== undefined && status === 'outcome_unknown',
        ),
      ],
    });
    if (terminalStatus !== undefined) {
      assertRunTransition(state.runStatus, terminalStatus);
      state.runStatus = terminalStatus;
      const reasonCode =
        terminalStatus === 'outcome_unknown'
          ? eventDrafts.find(({ name }) => name === 'node.outcome_unknown')
              ?.reasonCode
          : undefined;
      eventDrafts.push(
        event(`run.${terminalStatus}`, input.occurredAt, { reasonCode }),
      );
    }
  } else {
    const allWorkWaiting =
      state.runStatus === 'running' &&
      nonterminal.length > 0 &&
      nonterminal.every(
        ({ status, invocationKey }) =>
          status === 'waiting' ||
          (status === 'pending' &&
            (state.joins.has(invocationKey) ||
              state.agents.get(invocationKey)?.phase.kind === 'approval_wait' ||
              (state.agents.get(invocationKey)?.phase.kind === 'running_tool' &&
                finalInvocations.some(
                  (child) =>
                    child.agentWork?.parentInvocationKey === invocationKey &&
                    child.waitKind === 'workflow_call',
                )))) ||
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
