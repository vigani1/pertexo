import type { deriveForEachUpstreams } from '../attempt/upstream-scope.js';
import type { InlineAttemptSettlement } from '../attempt/inline-settlement.types.js';
import type { InlineNodeRegistry } from '@pertexo/node-sdk/server';
import type {
  JsonValue,
  WorkspaceVariableValues,
} from '@pertexo/workflow-model';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';
import { assertNotAborted } from '../attempt/admission.js';
import { resolveAttemptFailures } from '../observation/coordinator-failures.js';
import {
  branchSelectionObservations,
  mergeCoordinatorObservations,
} from '../observation/coordinator.js';
import { forEachCoordinatorObservations } from '../observation/coordinator-loops.js';
import type { ExecutionNode } from '../compilation/workflow-executable.js';
import type {
  WorkflowObservation,
  InvocationState,
  IterationScopePart,
} from '../workflow-execution.js';
import {
  prepareWorkflowAdvance,
  type AdvanceWorkflowFromSchedulerStateInput,
} from './advance.js';
import type { AdvanceWorkflowInput } from './advance-workflow.js';
import { admitAttempts } from './plan.js';
import {
  type MutableWorkflowTransition,
  transitionEvent,
} from './transition-state.js';
import {
  prepareInlineInvocation,
  inlineFrontier,
  type PreparedInlineInvocation,
} from './inline-invocation.js';
import { WorkflowEngineError } from '../workflow-engine.errors.js';
import type { AttemptFailureObservation } from '../observation/persisted.js';

export interface InlineAdvanceOptions {
  readonly registry: InlineNodeRegistry;
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly newAttemptId: () => string;
  readonly canStore?: (value: JsonValue) => boolean;
  readonly deferUntilNextAdvance?: true;
  readonly deadlineAt?: number;
  readonly expressionEvaluator?: ExpressionEvaluator;
  readonly readValues: (
    request: Readonly<{
      invocationKeys: readonly string[];
      attemptIds: readonly string[];
      failureEntryKey?: string;
      forEachUpstreams?: ReturnType<typeof deriveForEachUpstreams>;
      iterationPath: readonly IterationScopePart[];
    }>,
  ) => Promise<
    Readonly<{
      runInput: JsonValue;
      variables?: WorkspaceVariableValues;
      outputs: readonly Readonly<{
        nodeId: string;
        invocationKey: string;
        value: JsonValue;
      }>[];
      attemptOutputs: readonly Readonly<{
        attemptId: string;
        value: JsonValue;
      }>[];
      sourceFailure?: JsonValue;
      loopResultsTooLarge?: true;
    }>
  >;
  readonly normalizeFailure: (error: unknown) => Pick<
    AttemptFailureObservation,
    'errorKind' | 'failureKind' | 'safeErrorCode' | 'minimumRetryDelayMillis'
  > &
    Readonly<{
      errorSummary?: string;
    }>;
}

/** A fresh advance can spend at most this much time and this many attempts inline. */
const INLINE_ADVANCE_BUDGET = Object.freeze({ attempts: 16, millis: 50 });

export type Chain = Readonly<{
  input: AdvanceWorkflowInput;
  options: InlineAdvanceOptions;
  state: MutableWorkflowTransition;
  nodes: ReadonlyMap<string, ExecutionNode>;
  settled: InlineAttemptSettlement[];
}>;

export type Candidate = Readonly<{
  invocation: InvocationState;
  node: ExecutionNode;
}>;

export async function advanceInlineChain(
  input: AdvanceWorkflowInput,
  schedulerInput: AdvanceWorkflowFromSchedulerStateInput,
  nodes: ReadonlyMap<string, ExecutionNode>,
  options: InlineAdvanceOptions,
) {
  const { state, apply, finish } = prepareWorkflowAdvance(schedulerInput);
  const settled: InlineAttemptSettlement[] = [];
  const chain = { input, options, state, nodes, settled };
  const stopAt = options.monotonicNow() + INLINE_ADVANCE_BUDGET.millis;
  let frontier = inlineFrontier(chain);
  if (options.deferUntilNextAdvance && frontier.kind === 'inline')
    return finish(state, { yieldInline: true });

  let occurredAt = input.occurredAt;
  for (; frontier.kind === 'inline'; frontier = inlineFrontier(chain)) {
    const { candidate } = frontier;
    assertNotAborted(input.signal);
    const remaining = stopAt - options.monotonicNow();
    if (settled.length >= INLINE_ADVANCE_BUDGET.attempts || remaining <= 0)
      return finish(state, {
        inlineAttempts: settled,
        yieldInline: settled.length > 0,
        attemptKeys:
          settled.length === 0 ? [candidate.invocation.invocationKey] : [],
        occurredAt,
      });

    const prepared = await prepareInlineInvocation(chain, candidate, {
      remaining,
      stopAt,
    });
    if (prepared.kind === 'budget')
      return finish(state, {
        inlineAttempts: settled,
        yieldInline: settled.length > 0,
        attemptKeys:
          settled.length === 0 ? [candidate.invocation.invocationKey] : [],
        occurredAt,
      });
    occurredAt = prepared.occurredAt;
    if (prepared.kind === 'deadline') {
      apply([{ kind: 'deadline_expired', occurredAt }], occurredAt);
      return finish(state, { inlineAttempts: settled, occurredAt });
    }

    const { observations, checkpoint } = settleInvocation(
      chain,
      candidate,
      prepared,
    );
    const loopFacts = deriveLocalControlFacts(chain, checkpoint, observations);
    apply(observations, occurredAt);
    if (settledLoopBatch(state, checkpoint, loopFacts))
      return finish(state, {
        inlineAttempts: settled,
        yieldInline: true,
        occurredAt,
      });
  }
  return finish(state, {
    inlineAttempts: settled,
    occurredAt,
    attemptKeys: frontier.attemptKeys,
  });
}

function settleInvocation(
  { input, options, state, nodes, settled }: Chain,
  { invocation }: Candidate,
  {
    startedAt,
    occurredAt,
    durationMillis,
    mapped,
    timedOut,
    outputAdmitted,
    result,
    failure,
  }: PreparedInlineInvocation,
) {
  const [admission] = admitAttempts(
    state,
    [invocation.invocationKey],
    occurredAt,
  );
  if (admission === undefined)
    throw new WorkflowEngineError(
      'transition_invalid',
      'inline attempt was not admitted',
    );
  const attemptId = options.newAttemptId();

  const identity = {
    ...admission,
    attemptId,
    startedAt,
    durationMillis,
    ...(mapped === undefined || options.canStore?.(mapped) === false
      ? {}
      : { input: mapped }),
  };
  const running = state.invocations.get(invocation.invocationKey);
  state.eventDrafts.push(
    transitionEvent('node.started', identity.startedAt, {
      invocation: running,
    }),
  );
  const checkpoint = {
    ...state.current,
    invocations: [...state.invocations.values()],
    joins: [...state.joins.values()],
    loops: [...state.loops.values()],
  };
  const output = { kind: 'inline' as const, attemptId };
  const base = {
    invocationKey: invocation.invocationKey,
    coordinatorDerived: true as const,
  };
  const observations: WorkflowObservation[] = [];
  if (timedOut) {
    const safeErrorCode = 'execution.deadline_exceeded';
    settled.push({ ...identity, kind: 'timed_out', safeErrorCode });
    observations.push(
      { kind: 'deadline_expired', occurredAt },
      {
        ...base,
        kind: 'outcome',
        status: 'timed_out',
        reasonCode: safeErrorCode,
      },
    );
  } else if (!outputAdmitted) {
    const safeErrorCode = 'execution.output_invalid';
    settled.push({ ...identity, kind: 'failed', safeErrorCode });
    observations.push({
      ...base,
      kind: 'outcome',
      status: 'failed',
      reasonCode: safeErrorCode,
    });
  } else if (result?.kind === 'succeeded') {
    settled.push({ ...identity, kind: 'succeeded', output: result.output });
    observations.push(
      { ...base, kind: 'outcome', status: 'succeeded', output },
      ...inlineBranchSelection(nodes, state, identity, result.output),
    );
  } else if (failure !== undefined) {
    const [decision] = resolveAttemptFailures({
      runId: input.runId,
      failures: [
        {
          ...base,
          ...failure,
          kind: 'attempt_failure',
          occurredAt,
          attemptId,
          attemptNumber: admission.attemptNumber,
          possiblyDispatched: false,
        },
      ],
      invocations: state.invocations,
      nodes,
      retryPolicyReference: input.executable.envelope.runtimePolicies.retry,
      controlCanceled: false,
      controlDeadline: false,
    });
    if (decision?.kind === 'wait') {
      settled.push({
        ...identity,
        ...failure,
        kind: 'executor_failure',
        disposition: 'retry',
        dueAt: decision.resumeAt,
      });
      observations.push(decision);
    } else if (
      decision?.kind === 'outcome' &&
      (decision.status === 'failed' ||
        decision.status === 'canceled' ||
        decision.status === 'outcome_unknown')
    ) {
      settled.push({
        ...identity,
        ...failure,
        kind: 'executor_failure',
        disposition: decision.status,
      });
      observations.push(decision);
    } else {
      throw new WorkflowEngineError(
        'transition_invalid',
        'inline failure has no disposition',
      );
    }
  } else {
    throw new WorkflowEngineError(
      'transition_invalid',
      'inline attempt has no outcome',
    );
  }

  return { observations, checkpoint };
}

function deriveLocalControlFacts(
  { input, nodes, state }: Chain,
  checkpoint: MutableWorkflowTransition['current'],
  observations: WorkflowObservation[],
) {
  const loopObservations = forEachCoordinatorObservations({
    completedItems: [],
    persistedItems: [],
    successfulOutcomes: new Map(),
    checkpoint,
    invocations: state.invocations,
    nodes,
    derivedObservations: observations,
  }).observations;
  observations.push(
    ...mergeCoordinatorObservations(
      input.executable,
      checkpoint,
      observations,
      nodes,
    ),
    ...loopObservations,
  );

  return loopObservations;
}

function settledLoopBatch(
  state: MutableWorkflowTransition,
  checkpoint: MutableWorkflowTransition['current'],
  loopObservations: readonly WorkflowObservation[],
): boolean {
  return loopObservations.some((observation) => {
    if (observation.kind !== 'loop_iteration_completed') return false;
    const next = state.loops.get(observation.controlInvocationKey);
    const previous = checkpoint.loops.find(
      (loop) => loop.controlInvocationKey === observation.controlInvocationKey,
    );
    return (
      next?.terminalStatus !== undefined ||
      (next?.activeOrdinals.some(
        (ordinal) => !previous?.activeOrdinals.includes(ordinal),
      ) ??
        false)
    );
  });
}

function inlineBranchSelection(
  nodes: ReadonlyMap<string, ExecutionNode>,
  state: MutableWorkflowTransition,
  identity: Readonly<{ invocationKey: string; attemptId: string }>,
  value: JsonValue,
) {
  const { attemptId, invocationKey } = identity;
  const sequence = state.current.nextEventSequence;
  const output = { kind: 'inline' as const, attemptId };
  return branchSelectionObservations({
    completedItems: [
      {
        sequence,
        attemptId,
        invocationKey: invocationKey,
        value,
      },
    ],
    successfulOutcomes: new Map([
      [
        `${String(sequence)}\u0000${attemptId}\u0000${invocationKey}`,
        { invocationKey, status: 'succeeded', output },
      ],
    ]),
    invocations: state.invocations,
    nodes,
  });
}
