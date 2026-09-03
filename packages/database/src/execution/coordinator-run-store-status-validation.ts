import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
} from './coordinator-run-store-contract.js';
import { terminalStatus } from './coordinator-run-store-observations.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { sameKeys } from './coordinator-run-store-plan-validation.js';
import {
  assertPlan,
  sameStoredValue,
} from './coordinator-run-store-validation-values.js';
import type { PersistedWorkflowCheckpoint } from '../compatibility/persisted-workflow-checkpoint.js';

type Invocation = PersistedWorkflowCheckpoint['invocations'][number];
type PersistedFact = Readonly<{
  invocationKey: string | null;
  observation: Readonly<Record<string, unknown>>;
  type: string;
}>;
type PersistedState = Readonly<{
  nodeFacts: ReadonlySet<string>;
  observations: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}>;
type TransitionContext = Readonly<{
  current: PersistedWorkflowCheckpoint;
  plan: ParsedTransitionPlan;
  currentInvocations: ReadonlyMap<string, Invocation>;
  expectedNodeEvents: Set<string>;
  persisted: PersistedState;
  plannedNodeEvents: ReadonlySet<string>;
}>;

function nodeEventKey(invocation: Invocation, name: string): string {
  return `${invocation.invocationKey}:${name}`;
}

function indexPersistedFacts(facts: readonly PersistedFact[]): PersistedState {
  const nodeFacts = new Set<string>();
  const observations = new Map<string, Readonly<Record<string, unknown>>>();
  for (const fact of facts) {
    if (fact.type.startsWith('node.') && fact.invocationKey === null) {
      throw new CoordinatorRunStateCorruptError();
    }
    if (fact.invocationKey === null) continue;
    nodeFacts.add(`${fact.invocationKey}:${fact.type}`);
    observations.set(fact.invocationKey, fact.observation);
  }
  return { nodeFacts, observations };
}

function isDeclaredLoopBarrier(
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
  invocationKey: string,
): boolean {
  return plan.checkpoint.loops.some(
    ({ controlInvocationKey }) =>
      controlInvocationKey === invocationKey &&
      !current.loops.some(
        (loop) => loop.controlInvocationKey === controlInvocationKey,
      ),
  );
}

function validatePersistedFact(
  fact: PersistedFact,
  next: Invocation | undefined,
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
): void {
  const observation = fact.observation;
  if (observation.kind === 'wait') {
    assertPlan(next?.status === 'waiting');
    assertPlan(next.attemptNumber === observation.attemptNumber);
    assertPlan(next.resumeAt === observation.resumeAt);
    return;
  }
  if (observation.kind !== 'outcome') return;
  assertPlan(next !== undefined);
  const declaredLoopBarrier =
    next.status === 'waiting' &&
    next.resumeAt === undefined &&
    observation.status === 'succeeded' &&
    isDeclaredLoopBarrier(current, plan, next.invocationKey);
  assertPlan(next.status === observation.status || declaredLoopBarrier);
  assertPlan(next.attemptNumber === observation.attemptNumber);
  assertPlan(sameStoredValue(next.output ?? null, observation.output ?? null));
}

function validatePersistedFacts(
  facts: readonly PersistedFact[],
  nextInvocations: ReadonlyMap<string, Invocation>,
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
): void {
  for (const fact of facts) {
    if (fact.invocationKey === null) continue;
    validatePersistedFact(
      fact,
      nextInvocations.get(fact.invocationKey),
      current,
      plan,
    );
  }
}

function validateNewInvocation(
  context: TransitionContext,
  next: Invocation,
): void {
  if (
    next.status === 'pending' &&
    context.plan.checkpoint.joins.some(({ joinId }) => joinId === next.nodeId)
  ) {
    return;
  }
  const eventName = next.status === 'skipped' ? 'node.skipped' : 'node.ready';
  const key = nodeEventKey(next, eventName);
  context.expectedNodeEvents.add(key);
  assertPlan(context.plannedNodeEvents.has(key));
}

function acceptWaitingToReady(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
): boolean {
  if (previous.status !== 'waiting' || next.status !== 'ready') return false;
  const key = nodeEventKey(next, 'node.ready');
  context.expectedNodeEvents.add(key);
  assertPlan(context.plannedNodeEvents.has(key));
  assertPlan(next.attemptNumber === previous.attemptNumber);
  assertPlan(next.resumeAt === undefined);
  assertPlan(sameStoredValue(next.output ?? null, previous.output ?? null));
  return true;
}

function acceptJoinStart(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
): boolean {
  const isJoinStart =
    previous.status === 'pending' &&
    next.status === 'running' &&
    context.plan.checkpoint.joins.some(({ joinId }) => joinId === next.nodeId);
  if (!isJoinStart) return false;
  const key = nodeEventKey(next, 'node.ready');
  context.expectedNodeEvents.add(key);
  assertPlan(context.plannedNodeEvents.has(key));
  assertPlan(next.attemptNumber === previous.attemptNumber + 1);
  return true;
}

function acceptAttemptStart(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
): boolean {
  const startsAttempt =
    (previous.status === 'ready' || previous.status === 'waiting') &&
    next.status === 'running';
  if (!startsAttempt) return false;
  if (previous.status === 'waiting') {
    context.expectedNodeEvents.add(nodeEventKey(next, 'node.ready'));
  }
  assertPlan(next.attemptNumber === previous.attemptNumber + 1);
  assertPlan(next.resumeAt === undefined);
  assertPlan(sameStoredValue(next.output ?? null, previous.output ?? null));
  return true;
}

function acceptAttemptFailure(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
  terminalEvent: string,
  observation: Readonly<Record<string, unknown>>,
): boolean {
  if (observation.kind !== 'attempt_failure') return false;
  const expectedEvent =
    next.status === 'waiting' ? 'node.retry_scheduled' : terminalEvent;
  const key = nodeEventKey(next, expectedEvent);
  context.expectedNodeEvents.add(key);
  assertPlan(context.plannedNodeEvents.has(key));
  assertPlan(next.attemptNumber === previous.attemptNumber);
  if (next.status === 'waiting') {
    assertPlan(next.resumeAt !== undefined);
    assertPlan(
      context.plan.events.find(
        (event) =>
          event.invocationKey === next.invocationKey &&
          event.name === expectedEvent,
      )?.dueAt === next.resumeAt,
    );
  }
  return true;
}

function acceptLoopBarrier(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
  observation: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return (
    isDeclaredLoopBarrier(context.current, context.plan, next.invocationKey) &&
    next.status === 'waiting' &&
    next.resumeAt === undefined &&
    observation?.kind === 'outcome' &&
    observation.status === 'succeeded' &&
    next.attemptNumber === previous.attemptNumber &&
    sameStoredValue(next.output ?? null, observation.output ?? null)
  );
}

function acceptPersistedCompletion(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
  terminalEvent: string,
  observation: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const sourceNames =
    next.status === 'waiting'
      ? ['node.waiting', 'node.retry_scheduled']
      : [terminalEvent];
  return (
    sourceNames.some((name) =>
      context.persisted.nodeFacts.has(`${next.invocationKey}:${name}`),
    ) &&
    observation !== undefined &&
    next.attemptNumber === previous.attemptNumber &&
    (next.status !== 'waiting' || next.resumeAt === observation.resumeAt) &&
    (next.status === 'waiting' ||
      (observation.status === next.status &&
        sameStoredValue(next.output ?? null, observation.output ?? null)))
  );
}

function acceptRunningCompletion(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
  terminalEvent: string,
): boolean {
  if (
    previous.status !== 'running' ||
    (next.status !== 'waiting' && terminalStatus(terminalEvent) === undefined)
  ) {
    return false;
  }
  const observation = context.persisted.observations.get(next.invocationKey);
  if (
    observation !== undefined &&
    acceptAttemptFailure(context, previous, next, terminalEvent, observation)
  ) {
    return true;
  }
  return (
    acceptLoopBarrier(context, previous, next, observation) ||
    acceptPersistedCompletion(
      context,
      previous,
      next,
      terminalEvent,
      observation,
    )
  );
}

function acceptUnstartedTerminal(
  context: TransitionContext,
  previous: Invocation,
  next: Invocation,
  terminalEvent: string,
): boolean {
  const isTerminal =
    (previous.status === 'ready' || previous.status === 'waiting') &&
    terminalStatus(terminalEvent) !== undefined &&
    context.plannedNodeEvents.has(nodeEventKey(next, terminalEvent));
  if (!isTerminal) return false;
  context.expectedNodeEvents.add(nodeEventKey(next, terminalEvent));
  assertPlan(next.attemptNumber === previous.attemptNumber);
  assertPlan(next.resumeAt === undefined);
  assertPlan(sameStoredValue(next.output ?? null, previous.output ?? null));
  return true;
}

function validateInvocationTransition(
  context: TransitionContext,
  next: Invocation,
): void {
  const previous = context.currentInvocations.get(next.invocationKey);
  if (previous === undefined) {
    validateNewInvocation(context, next);
    return;
  }
  assertPlan(previous.nodeId === next.nodeId);
  if (previous.status === next.status) {
    assertPlan(sameStoredValue(previous, next));
    return;
  }
  const terminalEvent = `node.${next.status}`;
  if (
    acceptWaitingToReady(context, previous, next) ||
    acceptJoinStart(context, previous, next) ||
    acceptAttemptStart(context, previous, next) ||
    acceptRunningCompletion(context, previous, next, terminalEvent) ||
    acceptUnstartedTerminal(context, previous, next, terminalEvent)
  ) {
    return;
  }
  throw new CoordinatorPlanInvalidError();
}

function validateNodeEvents(context: TransitionContext): void {
  for (const next of context.plan.checkpoint.invocations) {
    validateInvocationTransition(context, next);
  }
  const plannedNodeEventCount = context.plan.events.filter(({ name }) =>
    name.startsWith('node.'),
  ).length;
  assertPlan(plannedNodeEventCount === context.expectedNodeEvents.size);
  assertPlan(sameKeys(context.plannedNodeEvents, context.expectedNodeEvents));
}

function validateRunEvents(
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
  terminalRunStatuses: ReadonlySet<string>,
): void {
  const expected = new Set<string>();
  if (
    current.runStatus === 'queued' &&
    plan.checkpoint.runStatus !== 'canceled' &&
    plan.checkpoint.runStatus !== 'timed_out'
  ) {
    expected.add('run.started');
  }
  if (
    current.runStatus !== 'waiting' &&
    plan.checkpoint.runStatus === 'waiting'
  ) {
    expected.add('run.waiting');
  }
  if (terminalRunStatuses.has(plan.checkpoint.runStatus)) {
    expected.add(`run.${plan.checkpoint.runStatus}`);
  }
  const planned = plan.events.filter(({ name }) => name.startsWith('run.'));
  assertPlan(planned.length === expected.size);
  assertPlan(planned.every(({ name }) => expected.has(name)));
}

export function assertStatusTransitionsValid(
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
  facts: readonly PersistedFact[],
  terminalRunStatuses: ReadonlySet<string>,
): void {
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const nextInvocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  assertPlan(
    current.invocations.every(({ invocationKey }) =>
      nextInvocations.has(invocationKey),
    ),
  );
  const persisted = indexPersistedFacts(facts);
  validatePersistedFacts(facts, nextInvocations, current, plan);
  const plannedNodeEvents = new Set(
    plan.events.flatMap((event) =>
      event.invocationKey === undefined
        ? []
        : [`${event.invocationKey}:${event.name}`],
    ),
  );
  validateNodeEvents({
    current,
    plan,
    currentInvocations,
    expectedNodeEvents: new Set<string>(),
    persisted,
    plannedNodeEvents,
  });
  validateRunEvents(current, plan, terminalRunStatuses);
}
