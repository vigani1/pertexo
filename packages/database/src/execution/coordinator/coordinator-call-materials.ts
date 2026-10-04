import type { PoolClient } from 'pg';
import { parseWorkflowExecutionValueSnapshot } from '../node-attempts/node-attempt-call-input-record.js';
import type { CoordinatorCheckpoint } from './coordinator-checkpoint.js';
import type { CoordinatorEventRow } from './coordinator-run-store-fact-physical-state.js';
import { loadCoordinatorCallFacts } from './coordinator-call-facts.js';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import type { PersistedWorkflowCallStateV1 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import type { NativeCoordinatorValueOwner } from './coordinator-native-value-read-contract.js';
import type { NativeCoordinatorCallDeclarationSource } from './coordinator-call-declaration-source.js';

export type CoordinatorCallMaterials = Readonly<{
  declarations: readonly Readonly<{
    invocationKey: string;
    nodeId: string;
    declarationAttemptId: string;
    input: Readonly<
      | { kind: 'inline'; attemptId: string }
      | { kind: 'artifact'; artifactId: string }
    >;
    inputChecksum: string;
    value: unknown;
    calleeVersionId: string;
    /** Deferred original-byte hydration outside the short SQL read transaction. */
    artifactSource?: NativeCoordinatorCallDeclarationSource;
  }>[];
  facts: readonly PersistedWorkflowCallStateV1[];
}>;

/** Fresh succeeded declaration events, not arbitrary node-output-shaped JSON. */
export async function loadCoordinatorCallMaterials(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    checkpoint: CoordinatorCheckpoint;
    events: readonly CoordinatorEventRow[];
    callNodeIds?: ReadonlySet<string>;
    consumer?: NativeCoordinatorValueOwner;
    loadDeclarations?: boolean;
  }>,
): Promise<CoordinatorCallMaterials | undefined> {
  if (input.checkpoint.schemaVersion !== 3) return undefined;
  if (input.consumer === undefined || input.callNodeIds === undefined)
    throw new CoordinatorRunStateCorruptError();
  const keys = input.events
    .filter(
      ({ type, node_id }) =>
        input.loadDeclarations !== false &&
        type === 'node.succeeded' &&
        node_id !== null &&
        input.callNodeIds?.has(node_id),
    )
    .flatMap(({ invocation_key }) =>
      invocation_key === null ? [] : [invocation_key],
    );
  if (keys.length > 64 || new Set(keys).size !== keys.length)
    throw new CoordinatorRunStateCorruptError();
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
          `select invocation_key,node_id,attempt_id,callee_version_id,snapshot from app.read_workflow_call_declaration_materials($1::uuid,$2::text[],$3::jsonb)`,
          [input.runId, keys, JSON.stringify(input.consumer)],
        );
  if (result.rows.length !== keys.length)
    throw new CoordinatorRunStateCorruptError();
  const remaining = new Set(keys);
  const declarations = result.rows.map((row) => {
    const event = input.events.find(
      ({ invocation_key }) => invocation_key === row.invocation_key,
    );
    if (
      !remaining.delete(row.invocation_key) ||
      event?.node_id !== row.node_id ||
      event.attempt_id !== row.attempt_id
    )
      throw new CoordinatorRunStateCorruptError();
    const snapshot = parseWorkflowExecutionValueSnapshot(row.snapshot);
    return Object.freeze({
      invocationKey: row.invocation_key,
      nodeId: row.node_id,
      declarationAttemptId: row.attempt_id,
      input:
        snapshot.reference.kind === 'inline'
          ? { kind: 'inline' as const, attemptId: row.attempt_id }
          : {
              kind: 'artifact' as const,
              artifactId: snapshot.reference.artifactId,
            },
      inputChecksum: snapshot.sha256,
      value:
        snapshot.reference.kind === 'inline'
          ? snapshot.reference.value
          : undefined,
      calleeVersionId: row.callee_version_id,
      ...(snapshot.reference.kind === 'inline'
        ? {}
        : {
            artifactSource: Object.freeze({
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              declarationAttemptId: row.attempt_id,
              calleeVersionId: row.callee_version_id,
              snapshot: Object.freeze({
                ...snapshot,
                reference: snapshot.reference,
              }),
            }),
          }),
    });
  });
  return Object.freeze({
    declarations: Object.freeze(declarations),
    facts: await loadCoordinatorCallFacts(client, input.runId),
  });
}
