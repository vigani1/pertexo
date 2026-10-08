import { workflowForEachBoundsV2 } from '@pertexo/workflow-model/graph';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import type { PersistedWorkflowCheckpoint } from '../../compatibility/persisted-workflow-checkpoint.js';
import { parseStoredExecutionValueV1 } from '../stored-execution-value.js';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import { mapEvent, record } from './coordinator-run-store-observations.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { sameStoredValue } from './coordinator-run-store-validation-values.js';

import {
  isRejectedForEachCollection,
  rejectedForEachCollectionCount as collectionCount,
} from './coordinator-rejected-loop-collection.js';
export { isRejectedForEachCollection } from './coordinator-rejected-loop-collection.js';
export type RejectedForEachDeclaration = Readonly<{
  attemptId: string;
  nodeId: string;
  attemptNumber: number;
}>;
export type RejectedForEachDeclarations = ReadonlyMap<
  string,
  RejectedForEachDeclaration
>;

function assertProof(value: boolean): asserts value {
  if (!value) throw new CoordinatorPlanInvalidError();
}

/** Derives only rejected declaration settlements from locked, owned physical
 * success facts and the same-version immutable executable. No I/O or mutation. */
export function deriveRejectedForEachDeclarations(
  input: Readonly<{
    executableJson: unknown;
    currentCheckpoint: PersistedWorkflowCheckpoint;
    plan: ParsedTransitionPlan;
    persistedFacts: readonly CoordinatorEventRow[];
  }>,
): ReadonlyMap<string, RejectedForEachDeclaration> {
  const candidates = input.plan.events.filter(
    (event) => event.reasonCode === 'loop_limit_exceeded',
  );
  if (candidates.length === 0) return new Map();
  try {
    return derive(input, candidates);
  } catch {
    throw new CoordinatorPlanInvalidError();
  }
}

function derive(
  {
    executableJson,
    currentCheckpoint: current,
    plan,
    persistedFacts,
  }: Parameters<typeof deriveRejectedForEachDeclarations>[0],
  candidates: ParsedTransitionPlan['events'],
): ReadonlyMap<string, RejectedForEachDeclaration> {
  const bounds = workflowForEachBoundsV2(executableJson);
  assertProof(
    current.schemaVersion === 2 && plan.checkpoint.schemaVersion === 2,
  );
  assertProof(current.workflowVersionId === plan.checkpoint.workflowVersionId);
  assertProof(
    current.runStatus === 'running' && plan.checkpoint.runStatus === 'failed',
  );
  assertProof(
    !current.cancelRequested &&
      !current.deadlineExpired &&
      !plan.checkpoint.cancelRequested &&
      !plan.checkpoint.deadlineExpired,
  );
  assertProof(
    plan.attempts.length === 0 && plan.nodeRunAdmissions.length === 0,
  );
  assertProof(
    plan.events.filter((event) => event.name === 'run.failed').length === 1,
  );
  assertProof(
    plan.events.every(
      (event) =>
        candidates.includes(event) ||
        event.name === 'run.failed' ||
        event.name === 'node.canceled' ||
        event.name === 'node.skipped',
    ),
  );
  const result = new Map<string, RejectedForEachDeclaration>();
  for (const event of candidates) {
    assertProof(
      event.name === 'node.failed' &&
        event.invocationKey !== undefined &&
        event.nodeId !== undefined,
    );
    const key = event.invocationKey;
    assertProof(!result.has(key));
    const previous = current.invocations.find(
      (invocation) => invocation.invocationKey === key,
    );
    const next = plan.checkpoint.invocations.find(
      (invocation) => invocation.invocationKey === key,
    );
    assertProof(previous !== undefined && next !== undefined);
    assertProof(
      previous.status === 'running' &&
        next.status === 'failed' &&
        previous.nodeId === event.nodeId &&
        next.nodeId === event.nodeId,
    );
    assertProof(
      event.attemptNumber === previous.attemptNumber &&
        next.attemptNumber === previous.attemptNumber &&
        previous.attemptNumber > 0,
    );
    assertProof(
      previous.output === undefined &&
        next.output === undefined &&
        next.resumeAt === undefined &&
        next.waitKind === undefined,
    );
    const branchPath =
      'branchPath' in previous ? (previous.branchPath ?? []) : [];
    const iterationPath =
      'iterationPath' in previous ? (previous.iterationPath ?? []) : [];
    assertProof(
      sameStoredValue(
        branchPath,
        'branchPath' in next ? (next.branchPath ?? []) : [],
      ) &&
        sameStoredValue(
          iterationPath,
          'iterationPath' in next ? (next.iterationPath ?? []) : [],
        ),
    );
    assertProof(
      key ===
        encodeWorkflowInvocationKeyV2({
          workflowVersionId: current.workflowVersionId,
          nodeId: previous.nodeId,
          branchPath: branchPath.map(
            (scope) => `${scope.nodeId}:${scope.outputPort}`,
          ),
          iterationPath,
        }),
    );
    assertProof(
      !current.loops.some((loop) => loop.controlInvocationKey === key) &&
        !plan.checkpoint.loops.some(
          (loop) => loop.controlInvocationKey === key,
        ),
    );
    const facts = persistedFacts.filter(
      (fact) => fact.type === 'node.succeeded' && fact.invocation_key === key,
    );
    assertProof(facts.length === 1);
    const fact = facts[0];
    assertProof(
      fact?.node_id === previous.nodeId &&
        fact.attempt_number === previous.attemptNumber,
    );
    const observation = record(mapEvent(fact));
    const payload = record(fact.payload);
    assertProof(
      payload.invocationKey === key &&
        payload.nodeId === previous.nodeId &&
        payload.attemptNumber === previous.attemptNumber,
    );
    assertProof(
      observation.kind === 'outcome' &&
        observation.status === 'succeeded' &&
        typeof observation.attemptId === 'string' &&
        observation.invocationKey === key,
    );
    const stored = parseStoredExecutionValueV1(fact.attempt_output_ref);
    assertProof(stored.kind === 'inline');
    assertProof(
      isRejectedForEachCollection({
        nodeId: previous.nodeId,
        iterationPath,
        value: stored.value,
        bounds,
        remainingIterationBudget: current.remainingIterationBudget,
      }),
    );
    const pin = bounds.get(previous.nodeId);
    const count = collectionCount(stored.value);
    assertProof(pin !== undefined && count !== undefined);
    if (count <= pin.maxIterations) {
      assertProof(
        plan.checkpoint.remainingIterationBudget ===
          current.remainingIterationBudget,
      );
      assertProof(
        !plan.checkpoint.loops.some(
          (loop) =>
            !current.loops.some(
              (existing) =>
                existing.controlInvocationKey === loop.controlInvocationKey,
            ),
        ),
      );
    }
    for (const [index, scope] of iterationPath.entries()) {
      const ancestors = current.loops.filter(
        (loop) =>
          loop.loopId === scope.loopNodeId &&
          sameStoredValue(loop.iterationPath, iterationPath.slice(0, index)) &&
          loop.activeOrdinals.includes(scope.ordinal) &&
          loop.branchPath.every((branch, ordinal) =>
            sameStoredValue(branch, branchPath[ordinal]),
          ),
      );
      assertProof(ancestors.length === 1);
    }
    result.set(
      key,
      Object.freeze({
        attemptId: observation.attemptId,
        nodeId: previous.nodeId,
        attemptNumber: previous.attemptNumber,
      }),
    );
  }
  return result;
}
