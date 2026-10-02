import type { PoolClient } from 'pg';
import { parseWorkflowExecutionValueSnapshot } from '../node-attempts/node-attempt-call-input-record.js';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import { loadCoordinatorCallFacts } from './coordinator-call-facts.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';

export type CoordinatorCallMaterials = Readonly<{
  declarations: readonly Readonly<{
    invocationKey: string;
    nodeId: string;
    declarationAttemptId: string;
    input: Readonly<{ kind: 'inline'; attemptId: string }>;
    inputChecksum: string;
    value: unknown;
    calleeVersionId: string;
  }>[];
  facts: readonly unknown[];
}>;

/** Fresh succeeded declaration events, not arbitrary node-output-shaped JSON. */
export async function loadCoordinatorCallMaterials(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    checkpoint: CoordinatorCheckpoint;
    events: readonly CoordinatorEventRow[];
  }>,
): Promise<CoordinatorCallMaterials | undefined> {
  if (input.checkpoint.schemaVersion !== 3) return undefined;
  const keys = input.events
    .filter(({ type }) => type === 'node.succeeded')
    .flatMap(({ invocation_key }) =>
      invocation_key === null ? [] : [invocation_key],
    );
  const result =
    keys.length === 0
      ? { rows: [] }
      : await client.query<{
          invocation_key: string;
          node_id: string;
          attempt_id: string;
          callee_version_id: string;
          snapshot: unknown;
        }>(
          `select invocation_key,node_id,attempt_id,callee_version_id,snapshot from app.read_workflow_call_declaration_materials($1::uuid,$2::text[])`,
          [input.runId, keys],
        );
  if (result.rows.length > 64) throw new CoordinatorRunStateCorruptError();
  const declarations = result.rows.map((row) => {
    const snapshot = parseWorkflowExecutionValueSnapshot(row.snapshot);
    if (snapshot.reference.kind !== 'inline')
      throw new CoordinatorRunStateCorruptError();
    return Object.freeze({
      invocationKey: row.invocation_key,
      nodeId: row.node_id,
      declarationAttemptId: row.attempt_id,
      input: { kind: 'inline' as const, attemptId: row.attempt_id },
      inputChecksum: snapshot.sha256,
      value: snapshot.reference.value,
      calleeVersionId: row.callee_version_id,
    });
  });
  return Object.freeze({
    declarations: Object.freeze(declarations),
    facts: await loadCoordinatorCallFacts(client, input.runId),
  });
}
