import { WorkflowEngineError } from './errors.js';
import { deriveReadyNodes } from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
import {
  admitLoopIterations,
  invocationKey as createInvocationKey,
  settleJoin,
} from './scheduling.js';
import { assertNodeTransition } from './transitions.js';
import type { InvocationState } from './types.js';
import {
  assertLoopInvocations,
  isSyntheticLegacyLoop,
  rootInvocationKey,
  schedulerNodeDisabled,
  transitionEvent as event,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

type TransitionInput = Readonly<{
  coordinatorNodeIds: ReadonlySet<string>;
  occurredAt: string;
}>;

function deriveRootReadiness(
  state: MutableWorkflowTransition,
  input: TransitionInput,
): void {
  const { current, graph, invocations, branchSelections } = state;
  if (
    graph?.deriveReadiness !== true ||
    state.cancelRequested ||
    state.deadlineExpired ||
    (state.runStatus !== 'running' && state.runStatus !== 'waiting')
  ) {
    return;
  }
  for (const decision of deriveReadyNodes({
    graph,
    workflowVersionId: current.workflowVersionId,
    invocations: [...invocations.values()],
    ...(current.schemaVersion === 2 ? { branchSelections } : {}),
  })) {
    if (input.coordinatorNodeIds.has(decision.nodeId)) continue;
    const invocation: InvocationState = {
      invocationKey: decision.invocationKey,
      nodeId: decision.nodeId,
      status: decision.disposition,
      attemptNumber: 0,
      ...(decision.branchPath === undefined
        ? {}
        : { branchPath: decision.branchPath }),
    };
    invocations.set(invocation.invocationKey, invocation);
    state.nodeRunAdmissionKeys.add(invocation.invocationKey);
    state.eventDrafts.push(
      event(
        decision.disposition === 'ready' ? 'node.ready' : 'node.skipped',
        input.occurredAt,
        invocation,
      ),
    );
  }
}

function deriveLoopBodyReadiness(
  state: MutableWorkflowTransition,
  input: TransitionInput,
): void {
  const { current, graph, invocations, branchSelections, loops } = state;
  if (
    graph?.deriveReadiness !== true ||
    state.cancelRequested ||
    state.deadlineExpired
  ) {
    return;
  }
  for (const loop of loops.values()) {
    const body = graph.structuredBodies?.find(
      ({ loopNodeId }) => loopNodeId === loop.loopId,
    );
    if (body === undefined && isSyntheticLegacyLoop(loop)) continue;
    if (body === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `structured body for ${loop.loopId} is missing`,
      );
    }
    for (const ordinal of loop.activeOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      for (const decision of deriveReadyNodes({
        graph: { deriveReadiness: true, nodes: body.nodes, edges: body.edges },
        workflowVersionId: current.workflowVersionId,
        invocations: [...invocations.values()],
        ...(current.schemaVersion === 2 ? { branchSelections } : {}),
        branchPath: loop.branchPath,
        iterationPath,
      })) {
        const invocation: InvocationState = {
          invocationKey: decision.invocationKey,
          nodeId: decision.nodeId,
          status: decision.disposition,
          attemptNumber: 0,
          branchPath: decision.branchPath ?? loop.branchPath,
          iterationPath,
        };
        invocations.set(invocation.invocationKey, invocation);
        state.nodeRunAdmissionKeys.add(invocation.invocationKey);
        state.eventDrafts.push(
          event(
            decision.disposition === 'ready' ? 'node.ready' : 'node.skipped',
            input.occurredAt,
            invocation,
          ),
        );
      }
    }
  }
}

function settlePendingJoins(
  state: MutableWorkflowTransition,
  input: TransitionInput,
): void {
  const { current, invocations, eventDrafts, joins } = state;
  for (const join of [...joins.values()].sort((left, right) =>
    compareOrdinal(left.joinId, right.joinId),
  )) {
    if (
      join.selectedBranchIds !== undefined ||
      join.unsatisfiedReasonCode !== undefined
    ) {
      continue;
    }
    const decision = settleJoin(join);
    if (decision.kind === 'waiting') continue;
    const joinKey =
      join.joinInvocationKey === undefined ||
      join.joinInvocationKey === join.joinId
        ? rootInvocationKey(current.workflowVersionId, join.joinId)
        : join.joinInvocationKey;
    const invocation = invocations.get(joinKey);
    if (invocation === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `join ${join.joinId} has no invocation`,
      );
    }
    if (decision.kind === 'satisfied') {
      joins.set(joinKey, {
        ...join,
        ledger: decision.ledger,
        selectedBranchIds: decision.selectedBranchIds,
      });
      if (invocation.status === 'pending') {
        assertNodeTransition(invocation.status, 'ready');
        const ready = { ...invocation, status: 'ready' as const };
        invocations.set(joinKey, ready);
        eventDrafts.push(event('node.ready', input.occurredAt, ready));
      }
      continue;
    }
    joins.set(joinKey, {
      ...join,
      ledger: decision.ledger,
      unsatisfiedReasonCode: decision.reasonCode,
    });
    if (invocation.status !== 'pending') continue;
    assertNodeTransition(invocation.status, 'ready');
    const ready = { ...invocation, status: 'ready' as const };
    eventDrafts.push(event('node.ready', input.occurredAt, ready));
    assertNodeTransition(ready.status, 'running');
    const running = { ...ready, status: 'running' as const };
    assertNodeTransition(running.status, 'failed');
    const failed = { ...running, status: 'failed' as const };
    invocations.set(joinKey, failed);
    eventDrafts.push(
      event('node.failed', input.occurredAt, failed, decision.reasonCode),
    );
  }
}

function completeExhaustedLoop(
  state: MutableWorkflowTransition,
  input: TransitionInput,
  loop: MutableWorkflowTransition['loops'] extends ReadonlyMap<string, infer L>
    ? L
    : never,
): void {
  if (
    loop.nextOrdinal !== loop.collectionSize ||
    loop.activeOrdinals.length !== 0
  ) {
    return;
  }
  const parent = state.invocations.get(loop.controlInvocationKey);
  if (parent === undefined) {
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      `loop ${loop.loopId} has no parent invocation`,
    );
  }
  if (parent.status === 'waiting') {
    assertNodeTransition(parent.status, 'succeeded');
    const succeeded = { ...parent, status: 'succeeded' as const };
    state.invocations.set(loop.controlInvocationKey, succeeded);
    state.eventDrafts.push(
      event('node.succeeded', input.occurredAt, succeeded),
    );
  } else if (parent.status === 'pending') {
    const ready = { ...parent, status: 'ready' as const };
    const running = { ...ready, status: 'running' as const };
    const succeeded = { ...running, status: 'succeeded' as const };
    state.invocations.set(loop.controlInvocationKey, succeeded);
    state.eventDrafts.push(event('node.ready', input.occurredAt, ready));
    state.eventDrafts.push(
      event('node.succeeded', input.occurredAt, succeeded),
    );
  }
}

function advanceLoopIterations(
  state: MutableWorkflowTransition,
  input: TransitionInput,
): void {
  if (state.cancelRequested || state.deadlineExpired) return;
  for (const loop of [...state.loops.values()].sort((left, right) =>
    compareOrdinal(left.controlInvocationKey, right.controlInvocationKey),
  )) {
    assertLoopInvocations(
      state.current.workflowVersionId,
      loop,
      state.invocations,
    );
    if (loop.terminalStatus !== undefined) continue;
    const admission = admitLoopIterations(loop, state.remainingIterationBudget);
    state.remainingIterationBudget = admission.remainingIterationBudget;
    state.loops.set(loop.controlInvocationKey, admission.loop);
    for (const ordinal of admission.admittedOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      for (const nodeId of loop.bodyRootNodeIds) {
        const legacy = isSyntheticLegacyLoop(loop);
        const iterationKey = createInvocationKey({
          workflowVersionId: state.current.workflowVersionId,
          nodeId,
          branchPath: loop.branchPath.map(
            ({ nodeId: branchNodeId, outputPort }) =>
              `${branchNodeId}:${outputPort}`,
          ),
          iterationPath,
        });
        if (state.invocations.has(iterationKey)) {
          throw new WorkflowEngineError(
            'loop_state_invalid',
            `loop body root ${iterationKey} was admitted twice`,
          );
        }
        const ready: InvocationState = {
          invocationKey: iterationKey,
          nodeId,
          status: schedulerNodeDisabled(state.graph, nodeId)
            ? 'skipped'
            : 'ready',
          attemptNumber: 0,
          ...(legacy ? {} : { branchPath: loop.branchPath, iterationPath }),
        };
        state.invocations.set(iterationKey, ready);
        state.nodeRunAdmissionKeys.add(iterationKey);
        state.eventDrafts.push(
          event(
            ready.status === 'skipped' ? 'node.skipped' : 'node.ready',
            input.occurredAt,
            ready,
          ),
        );
      }
    }
    completeExhaustedLoop(state, input, admission.loop);
  }
}

export function deriveWorkflowTransitions(
  state: MutableWorkflowTransition,
  input: TransitionInput,
): void {
  deriveRootReadiness(state, input);
  deriveLoopBodyReadiness(state, input);
  settlePendingJoins(state, input);
  advanceLoopIterations(state, input);
}
