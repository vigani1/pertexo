import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import {
  CoordinatorPlanInvalidError,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';
import type { prepareCoordinatorControls } from './coordinator-control-preparation.js';
import { loadRejectedForEachDeclarations } from './coordinator-rejected-loop-load.js';
import { deriveStoppedForEachDeclarations } from './coordinator-stopped-loop-proof.js';
import { readPhysicalAttempts } from './coordinator-run-store-fact-physical-state.js';

/** Existing locked settlement proof, with native exact-source fences before use. */
export async function lockCoordinatorControlSettlements(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowVersionId: string;
    plan: ParsedTransitionPlan;
    delivery: CoordinatorAdvanceDelivery;
    preparedControls?: Awaited<ReturnType<typeof prepareCoordinatorControls>>;
  }>,
  currentCheckpoint: CoordinatorCheckpoint,
  persistedFacts: readonly CoordinatorEventRow[],
  currentCancellationRequested: boolean,
  currentDeadlineExpired: boolean,
) {
  let stoppedForEachDeclarations = new Map() as ReturnType<
    typeof deriveStoppedForEachDeclarations
  >;
  if (
    currentCheckpoint.schemaVersion === 3 &&
    (currentCancellationRequested || currentDeadlineExpired)
  ) {
    if (
      input.plan.checkpoint.cancelRequested !== currentCancellationRequested ||
      input.plan.checkpoint.deadlineExpired !== currentDeadlineExpired ||
      input.plan.checkpoint.schemaVersion !== 3 ||
      !isDeepStrictEqual(
        input.plan.checkpoint.branchSelections,
        currentCheckpoint.branchSelections,
      ) ||
      !isDeepStrictEqual(
        input.plan.checkpoint.loops.map((loop) => loop.controlInvocationKey),
        currentCheckpoint.loops.map((loop) => loop.controlInvocationKey),
      )
    )
      throw new CoordinatorPlanInvalidError();
    const version = await client.query<{
      executable_schema_version: number;
      executable_json: unknown;
    }>(
      `select executable_schema_version,executable_json from app.workflow_versions
       where workspace_id=$1 and id=$2`,
      [input.workspaceId, input.workflowVersionId],
    );
    if (
      version.rows.length !== 1 ||
      version.rows[0]?.executable_schema_version !== 3
    )
      throw new CoordinatorPlanInvalidError();
    const physical = await readPhysicalAttempts(
      client,
      input.workspaceId,
      input.runId,
      persistedFacts.flatMap(({ attempt_id }) =>
        attempt_id === null ? [] : [attempt_id],
      ),
      true,
    );
    const facts = persistedFacts.map((fact) => {
      if (fact.attempt_id === null) return fact;
      const locked = physical.get(fact.attempt_id);
      if (locked === undefined) throw new CoordinatorPlanInvalidError();
      return Object.freeze({ ...fact, ...locked });
    });
    stoppedForEachDeclarations = deriveStoppedForEachDeclarations({
      executable: version.rows[0].executable_json,
      current: currentCheckpoint,
      plan: input.plan,
      facts,
      canceled: currentCancellationRequested,
      deadlineExpired: currentDeadlineExpired,
    });
  } else if (
    currentCheckpoint.schemaVersion === 3 &&
    persistedFacts.length > 0
  ) {
    if (input.preparedControls === undefined)
      throw new CoordinatorPlanInvalidError();
    const guarded = await client.query<{ result: unknown }>(
      'select app.lock_native_coordinator_control_sources($1::jsonb,$2::integer,$3::jsonb) as result',
      [
        JSON.stringify({
          workspaceId: input.workspaceId,
          runId: input.runId,
          workflowVersionId: input.workflowVersionId,
          expectedRevision: input.plan.expectedRevision,
          delivery: input.delivery,
        }),
        input.plan.consumedThroughEventSequence,
        JSON.stringify(input.preparedControls.sources),
      ],
    );
    if (
      guarded.rows.length !== 1 ||
      !isDeepStrictEqual(
        guarded.rows[0]?.result,
        input.preparedControls.sources,
      )
    )
      throw new CoordinatorPlanInvalidError();
  }
  const rejectedForEachDeclarations = await loadRejectedForEachDeclarations(
    client,
    {
      workspaceId: input.workspaceId,
      workflowVersionId: input.workflowVersionId,
      currentCheckpoint,
      plan: input.plan,
      persistedFacts,
      ...(input.preparedControls === undefined
        ? {}
        : { nativeCollections: input.preparedControls.collections }),
    },
  );
  return { rejectedForEachDeclarations, stoppedForEachDeclarations };
}
