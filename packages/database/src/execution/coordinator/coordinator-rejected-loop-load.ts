import type { PoolClient } from 'pg';
import type { CoordinatorCheckpoint as PersistedWorkflowCheckpoint } from './coordinator-checkpoint.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import {
  deriveRejectedForEachDeclarations,
  type RejectedForEachDeclarations,
} from './coordinator-rejected-loop-proof.js';

/** Load the same-version immutable pin only for a declaration rejection. */
export async function loadRejectedForEachDeclarations(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowVersionId: string;
    currentCheckpoint: PersistedWorkflowCheckpoint;
    plan: ParsedTransitionPlan;
    persistedFacts: readonly CoordinatorEventRow[];
  }>,
): Promise<RejectedForEachDeclarations> {
  if (
    !input.plan.events.some(
      (event) =>
        event.name === 'node.failed' &&
        event.reasonCode === 'loop_limit_exceeded',
    )
  )
    return new Map();
  const version = await client.query<{
    executable_schema_version: number | null;
    executable_json: unknown;
  }>(
    `select executable_schema_version,executable_json from app.workflow_versions
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.workflowVersionId],
  );
  if (
    version.rows[0]?.executable_schema_version !==
    (input.currentCheckpoint.schemaVersion === 3 ? 3 : 2)
  )
    throw new CoordinatorRunStateCorruptError();
  return deriveRejectedForEachDeclarations({
    executableJson: version.rows[0].executable_json,
    currentCheckpoint: input.currentCheckpoint,
    plan: input.plan,
    persistedFacts: input.persistedFacts,
  });
}
