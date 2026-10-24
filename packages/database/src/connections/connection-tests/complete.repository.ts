import { generatePersistedId } from '../../platform/persisted-id.js';
import type { Pool } from 'pg';
import {
  uuidSchema,
  CONNECTION_EVENT_TYPE,
  ConnectionNotFoundError,
  ConnectionTestInProgressError,
  keyDigest,
  withConnectionTransaction,
  parseRequestMetadata,
  selectConnection,
  connectionTestOutcomeSchema,
  serializeConnectionTestResult,
} from '../records.queries.js';
import { connectionTestClaimSchema, connectionTestScope } from './claim.js';

import { applyCurrentConnectionTestHealth } from '../health/transitions.repository.js';
import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

import { classifyConnectionTestCompletion } from './classify-completion.js';
import type { ConnectionTestPersistence } from './results.repository.js';

export async function completePersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['completeConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['completeConnectionTest']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const secretVersionId = uuidSchema.parse(input.secretVersionId);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
  const outcome = connectionTestOutcomeSchema.parse(input.outcome);
  return withConnectionTransaction(pool, input.workspaceId, {
    actorId,
    operation: async (client, workspaceId) => {
      const claim = await client.query<{ result_ref: unknown }>(
        `select result_ref from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5 for update`,
        [workspaceId, scope, digest, requestHash, dispatchToken],
      );
      if (claim.rows[0] === undefined)
        throw new ConnectionTestInProgressError(
          'Connection test completion ownership was lost',
        );
      const claimState = connectionTestClaimSchema.parse(
        claim.rows[0].result_ref,
      );
      if (
        claimState.secretVersionId !== undefined &&
        claimState.secretVersionId !== secretVersionId
      )
        throw new ConnectionTestInProgressError(
          'Connection test secret version does not match credential evidence',
        );
      const requiresDispatchedClaim =
        (outcome.ok ||
          outcome.httpStatus !== null ||
          outcome.reauthorizationRequired) &&
        claimState.state !== 'dispatched';
      if (requiresDispatchedClaim)
        throw new ConnectionTestInProgressError(
          'Connection test has no dispatch evidence',
        );
      const current = await selectConnection(
        client,
        workspaceId,
        connectionId,
        { lock: true },
      );
      if (current === null)
        throw new ConnectionNotFoundError('Connection is not visible');

      const currentSecretWasTested =
        current.currentSecretVersionId === secretVersionId;
      const classification = classifyConnectionTestCompletion(
        current.status,
        outcome,
        secretVersionId,
        { currentSecretWasTested },
      );
      const connection = await applyCurrentConnectionTestHealth(client, {
        current,
        secretVersionId,
        healthRevision: claimState.healthRevision,
        outcome,
        actorId,
        ...metadata,
      });
      await client.query(
        `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, $4, 'user', $5, $6, $7, $8::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          connectionId,
          outcome.ok
            ? CONNECTION_EVENT_TYPE.testSucceeded
            : CONNECTION_EVENT_TYPE.testFailed,
          actorId,
          metadata.requestId,
          metadata.traceId,
          JSON.stringify(classification.eventMetadata),
        ],
      );
      const result = Object.freeze({ connection, outcome });
      await client.query(
        `update app.idempotency_records
             set status = 'completed', result_ref = $1::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $2 and operation = 'connection.test'
               and scope = $3 and key_hash = $4`,
        [
          JSON.stringify(serializeConnectionTestResult(result)),
          workspaceId,
          scope,
          digest,
        ],
      );
      return result;
    },
  });
}
