import type { PoolClient } from 'pg';
import {
  persistedWorkflowCallStateSchemaV1,
  type PersistedWorkflowCallStateV1,
} from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';

/** Immutable journal plus accepted-child terminal truth, without child row locks. */
export async function loadCoordinatorCallFacts(
  client: PoolClient,
  parentRunId: string,
): Promise<readonly PersistedWorkflowCallStateV1[]> {
  const result = await client.query<{ fact: unknown }>(
    `select fact from app.read_workflow_call_facts($1::uuid)`,
    [parentRunId],
  );
  if (result.rows.length > 64) throw new CoordinatorRunStateCorruptError();
  try {
    return Object.freeze(
      result.rows.map(({ fact }) =>
        persistedWorkflowCallStateSchemaV1.parse(
          JSON.parse(serializeStoredExecutionJsonValue(fact)) as unknown,
        ),
      ),
    );
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}
