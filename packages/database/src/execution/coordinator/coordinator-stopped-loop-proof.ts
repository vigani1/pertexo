import { isDeepStrictEqual } from 'node:util';
import { workflowForEachBoundsV3 } from '@pertexo/workflow-model/graph';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { mapEvent, record } from './coordinator-run-store-observations.js';
import type { RejectedForEachDeclaration } from './coordinator-rejected-loop-proof.js';
import { coordinatorControlPins } from './coordinator-control-facts.js';

export type StoppedForEachDeclaration = RejectedForEachDeclaration &
  Readonly<{
    status: 'canceled' | 'timed_out';
  }>;
export type StoppedForEachDeclarations = ReadonlyMap<
  string,
  StoppedForEachDeclaration
>;
function require(value: boolean): asserts value {
  if (!value) throw new CoordinatorPlanInvalidError();
}

/** Logical stop only: independently locked physical success is never rewritten. */
export function deriveStoppedForEachDeclarations(
  input: Readonly<{
    executable: unknown;
    current: CoordinatorCheckpoint;
    plan: ParsedTransitionPlan;
    facts: readonly CoordinatorEventRow[];
    canceled: boolean;
    deadlineExpired: boolean;
  }>,
): StoppedForEachDeclarations {
  const { current, plan, facts } = input;
  require(current.schemaVersion === 3 && plan.checkpoint.schemaVersion === 3);
  require(input.canceled || input.deadlineExpired);
  require(plan.checkpoint.cancelRequested === input.canceled);
  require(plan.checkpoint.deadlineExpired === input.deadlineExpired);
  require(plan.attempts.length === 0 && plan.nodeRunAdmissions.length === 0);
  require(
    plan.checkpoint.remainingIterationBudget ===
      current.remainingIterationBudget,
  );
  require(
    isDeepStrictEqual(
      plan.checkpoint.branchSelections,
      current.branchSelections,
    ),
  );
  require(
    isDeepStrictEqual(
      plan.checkpoint.loops.map(
        ({ controlInvocationKey }) => controlInvocationKey,
      ),
      current.loops.map(({ controlInvocationKey }) => controlInvocationKey),
    ),
  );
  require(
    isDeepStrictEqual(
      plan.checkpoint.joins.map(
        ({ joinInvocationKey, joinId }) => joinInvocationKey ?? joinId,
      ),
      current.joins.map(
        ({ joinInvocationKey, joinId }) => joinInvocationKey ?? joinId,
      ),
    ),
  );
  const bounds = workflowForEachBoundsV3(input.executable);
  const pins = coordinatorControlPins(input.executable);
  const status = input.canceled ? 'canceled' : 'timed_out';
  const result = new Map<string, StoppedForEachDeclaration>();
  for (const fact of facts) {
    if (fact.type !== 'node.succeeded' || fact.node_id === null) continue;
    if (pins.get(fact.node_id)?.kind === 'parallel')
      require(
        record(mapEvent(fact)).output !== undefined &&
          record(record(mapEvent(fact)).output).kind === 'inline',
      );
    const pin = bounds.get(fact.node_id);
    if (pin === undefined) continue;
    const observation = record(mapEvent(fact));
    const payload = record(fact.payload);
    const key = fact.invocation_key;
    require(typeof key === 'string' && !result.has(key));
    const previous = current.invocations.find(
      ({ invocationKey }) => invocationKey === key,
    );
    const next = plan.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === key,
    );
    require(previous?.status === 'running' && next?.status === status);
    require(previous.nodeId === fact.node_id && next.nodeId === fact.node_id);
    require(
      previous.attemptNumber > 0 &&
        next.attemptNumber === previous.attemptNumber,
    );
    require(fact.attempt_number === previous.attemptNumber);
    require(
      fact.sequence >= current.nextEventSequence &&
        fact.sequence <= plan.consumedThroughEventSequence,
    );
    require(
      fact.current_attempt_id === fact.attempt_id &&
        fact.attempt_status === 'succeeded',
    );
    require(
      fact.node_status === 'succeeded' && fact.attempt_id === payload.attemptId,
    );
    require(
      fact.node_run_id === payload.nodeRunId && payload.schemaVersion === 1,
    );
    require(
      payload.nodeId === previous.nodeId &&
        payload.invocationKey === key &&
        payload.attemptNumber === previous.attemptNumber,
    );
    require(
      observation.kind === 'outcome' &&
        observation.status === 'succeeded' &&
        typeof observation.attemptId === 'string',
    );
    require(isDeepStrictEqual(fact.attempt_output_ref, fact.node_output_ref));
    require(isDeepStrictEqual(next.output, observation.output));
    require(
      previous.output === undefined &&
        next.resumeAt === undefined &&
        next.waitKind === undefined,
    );
    const branchPath = previous.branchPath ?? [];
    const iterationPath = previous.iterationPath ?? [];
    require(
      isDeepStrictEqual(record(fact.branch_context), {
        ...(previous.branchPath === undefined
          ? {}
          : { branchPath: previous.branchPath }),
        ...(previous.iterationPath === undefined
          ? {}
          : { iterationPath: previous.iterationPath }),
      }),
    );
    require(
      isDeepStrictEqual(branchPath, next.branchPath ?? []) &&
        isDeepStrictEqual(iterationPath, next.iterationPath ?? []),
    );
    require(
      isDeepStrictEqual(
        pin.ancestorLoopNodeIds,
        iterationPath.map(({ loopNodeId }) => loopNodeId),
      ),
    );
    require(
      key ===
        encodeWorkflowInvocationKeyV2({
          workflowVersionId: current.workflowVersionId,
          nodeId: previous.nodeId,
          branchPath: branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          iterationPath,
        }),
    );
    require(
      !current.loops.some(
        ({ controlInvocationKey }) => controlInvocationKey === key,
      ),
    );
    for (const [index, scope] of iterationPath.entries()) {
      require(
        current.loops.filter(
          (loop) =>
            loop.loopId === scope.loopNodeId &&
            isDeepStrictEqual(
              loop.iterationPath,
              iterationPath.slice(0, index),
            ) &&
            loop.activeOrdinals.includes(scope.ordinal) &&
            loop.terminalStatus === undefined &&
            loop.branchPath.every((branch, ordinal) =>
              isDeepStrictEqual(branch, branchPath[ordinal]),
            ),
        ).length === 1,
      );
    }
    const events = plan.events.filter(
      ({ invocationKey }) => invocationKey === key,
    );
    require(
      events.length === 1 &&
        events[0]?.name === `node.${status}` &&
        events[0].nodeId === previous.nodeId &&
        events[0].attemptNumber === previous.attemptNumber &&
        events[0].reasonCode === undefined,
    );
    result.set(
      key,
      Object.freeze({
        attemptId: observation.attemptId,
        nodeId: previous.nodeId,
        attemptNumber: previous.attemptNumber,
        status,
      }),
    );
  }
  for (const previous of current.invocations) {
    const next = plan.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === previous.invocationKey,
    );
    if (
      previous.status === 'running' &&
      next?.status === status &&
      facts.some(
        (fact) =>
          fact.type === 'node.succeeded' &&
          fact.invocation_key === previous.invocationKey,
      )
    )
      require(result.has(previous.invocationKey));
  }
  return result;
}
