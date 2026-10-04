import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  CallableCompletionStoppedError,
  callableValueWorkStopSchema,
} from '@pertexo/workflow-model/workflow-call-contract';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { parseCoordinatorCheckpoint } from './coordinator-checkpoint.js';
import {
  coordinatorControlFactWindow,
  coordinatorControlPins,
} from './coordinator-control-facts.js';
import { parseCoordinatorControlDeclarationInventory } from './coordinator-control-declaration-source.js';
import {
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
  validatePersistedFactBatch,
} from './coordinator-run-store-observation-facts.js';
import type { NativeCoordinatorValueOwner } from './coordinator-native-value-read-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';

/** Fresh bounded fact/pin/metadata selection only. No value work in the transaction. */
export async function loadCoordinatorControlPrecommitMaterial(
  client: PoolClient,
  owner: NativeCoordinatorValueOwner,
  plan: ParsedTransitionPlan,
) {
  const header = await client.query<{
    scheduler_state: unknown;
    executable_json: unknown;
  }>(
    `select checkpoint.scheduler_state,version.executable_json
     from app.run_checkpoints checkpoint
     join app.workflow_runs run on run.workspace_id=checkpoint.workspace_id
       and run.id=checkpoint.workflow_run_id and run.workflow_version_id=checkpoint.workflow_version_id
     join app.workflow_versions version on version.workspace_id=run.workspace_id
       and version.id=run.workflow_version_id and version.workflow_id=run.workflow_id
     where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2
       and checkpoint.workflow_version_id=$3 and checkpoint.revision=$4
       and version.schema_version=2 and version.executable_schema_version=3`,
    [
      owner.workspaceId,
      owner.runId,
      owner.workflowVersionId,
      owner.expectedRevision,
    ],
  );
  const row = header.rows[0];
  if (header.rows.length !== 1 || row === undefined)
    throw new CoordinatorPlanInvalidError();
  const checkpoint = parseCoordinatorCheckpoint(row.scheduler_state, 3);
  if (
    checkpoint.schemaVersion !== 3 ||
    checkpoint.revision !== owner.expectedRevision ||
    checkpoint.workflowVersionId !== owner.workflowVersionId ||
    checkpoint.nextEventSequence !== plan.expectedNextEventSequence
  )
    throw new CoordinatorPlanInvalidError();
  const capacity = await persistedFactCapacity(
    client,
    owner.workspaceId,
    owner.runId,
    checkpoint.nextEventSequence,
    plan.consumedThroughEventSequence,
  );
  const expected = Math.max(
    0,
    plan.consumedThroughEventSequence - checkpoint.nextEventSequence + 1,
  );
  if (capacity.count !== expected || capacity.count > maximumPersistedFacts)
    throw new CoordinatorPlanInvalidError();
  const facts = await readPersistedFacts(client, {
    workspaceId: owner.workspaceId,
    runId: owner.runId,
    count: capacity.count,
    firstSequence: checkpoint.nextEventSequence,
    lastSequence: plan.consumedThroughEventSequence,
    maximumStorageBytes: capacity.maximumStorageBytes,
  });
  if (
    facts.length !== expected ||
    facts.some(
      (fact, index) => fact.sequence !== checkpoint.nextEventSequence + index,
    )
  )
    throw new CoordinatorPlanInvalidError();
  validatePersistedFactBatch(facts);
  const window = coordinatorControlFactWindow({
    executable: row.executable_json,
    checkpoint,
    events: facts,
  });
  const inventory = await client.query<{ result: unknown }>(
    'select app.load_native_coordinator_control_sources($1::jsonb,$2::integer) as result',
    [JSON.stringify(owner), window.lastSequence],
  );
  if (inventory.rows.length !== 1) throw new CoordinatorPlanInvalidError();
  const stopped = z
    .object({ kind: z.literal('stopped'), stop: callableValueWorkStopSchema })
    .strict()
    .safeParse(inventory.rows[0]?.result);
  if (stopped.success)
    throw new CallableCompletionStoppedError(stopped.data.stop);
  const ready = z
    .object({ kind: z.literal('ready'), projection: z.unknown() })
    .strict()
    .parse(inventory.rows[0]?.result);
  const sources = parseCoordinatorControlDeclarationInventory(
    ready.projection,
    owner,
    window.identities,
  );
  return {
    checkpoint,
    sources,
    pins: coordinatorControlPins(row.executable_json),
    executable: row.executable_json,
  };
}
