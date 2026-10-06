import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import {
  assertPlan,
  sameStoredValue,
} from './coordinator-run-store-validation-values.js';
import type { CoordinatorCheckpoint as PersistedWorkflowCheckpoint } from './coordinator-checkpoint.js';

export type Invocation = PersistedWorkflowCheckpoint['invocations'][number];
export type PersistedFact = Readonly<{
  invocationKey: string | null;
  observation: Readonly<Record<string, unknown>>;
  type: string;
}>;
export type PersistedState = Readonly<{
  nodeFacts: ReadonlySet<string>;
  observations: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}>;
export function indexPersistedFacts(
  facts: readonly PersistedFact[],
): PersistedState {
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

export function isDeclaredLoopBarrier(
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
  rejectedForEachDeclarations: ReadonlySet<string>,
  stoppedForEachDeclarations: ReadonlySet<string>,
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
  if (
    plan.checkpoint.schemaVersion === 3 &&
    plan.checkpoint.calls.some(
      ({ invocationKey }) => invocationKey === next.invocationKey,
    )
  ) {
    const call = plan.checkpoint.calls.find(
      ({ invocationKey }) => invocationKey === next.invocationKey,
    );
    assertPlan(
      call !== undefined &&
        observation.status === 'succeeded' &&
        observation.attemptNumber === 1,
    );
    assertPlan(sameStoredValue(call.input, observation.output));
    return;
  }
  if (rejectedForEachDeclarations.has(next.invocationKey)) {
    assertPlan(next.status === 'failed' && observation.status === 'succeeded');
    assertPlan(next.attemptNumber === observation.attemptNumber);
    assertPlan(next.output === undefined);
    return;
  }
  if (stoppedForEachDeclarations.has(next.invocationKey)) {
    assertPlan(
      (next.status === 'canceled' || next.status === 'timed_out') &&
        observation.status === 'succeeded',
    );
    assertPlan(next.attemptNumber === observation.attemptNumber);
    assertPlan(sameStoredValue(next.output, observation.output));
    return;
  }
  const declaredLoopBarrier =
    next.status === 'waiting' &&
    next.resumeAt === undefined &&
    observation.status === 'succeeded' &&
    isDeclaredLoopBarrier(current, plan, next.invocationKey);
  assertPlan(next.status === observation.status || declaredLoopBarrier);
  assertPlan(next.attemptNumber === observation.attemptNumber);
  assertPlan(sameStoredValue(next.output ?? null, observation.output ?? null));
}

export function validatePersistedFacts(
  facts: readonly PersistedFact[],
  nextInvocations: ReadonlyMap<string, Invocation>,
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
  rejectedForEachDeclarations: ReadonlySet<string>,
  stoppedForEachDeclarations: ReadonlySet<string>,
): void {
  for (const fact of facts) {
    if (fact.invocationKey === null) continue;
    validatePersistedFact(
      fact,
      nextInvocations.get(fact.invocationKey),
      current,
      plan,
      rejectedForEachDeclarations,
      stoppedForEachDeclarations,
    );
  }
}
