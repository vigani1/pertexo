import { generatePersistedId } from '../../platform/persisted-id.js';
import type { Pool } from 'pg';
import {
  uuidSchema,
  providerKeySchema,
  CONNECTION_STATUS,
  CONNECTION_EVENT_TYPE,
  ConnectionNotFoundError,
  ConnectionIdempotencyConflictError,
  ConnectionUnavailableError,
  ConnectionTestInProgressError,
  keyDigest,
  mapConnection,
  mapSealed,
  withConnectionTransaction,
  parseRequestMetadata,
  selectConnection,
  connectionTestOutcomeSchema,
  parseConnectionTestResult,
  serializeConnectionTestResult,
} from '../records.js';
import {
  connectionTestClaim,
  connectionTestClaimSchema,
  connectionTestScope,
} from './claim.js';
import { requireConnectionUser } from '../authority.js';
import { markConnectionTestDispatched } from './dispatch.js';
import { applyCurrentConnectionTestHealth } from '../health/transitions.js';
import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';
import type { ConnectionDatabase } from '../records.js';
import { classifyConnectionTestCompletion } from './classify-completion.js';

export { classifyConnectionTestCompletion } from './classify-completion.js';
/** Owns connection-test claim, dispatch, completion, and abandonment. */

export type ConnectionTestPersistence = Pick<
  ConnectionDatabase,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;

export function createConnectionTestPersistence(
  pool: Pool,
): ConnectionTestPersistence {
  return Object.freeze({
    startConnectionTest: (input) => startPersistedConnectionTest(pool, input),

    resolveConnectionTestSecret: (input) =>
      resolvePersistedConnectionTestSecret(pool, input),

    markConnectionTestDispatched: (input) => {
      return markConnectionTestDispatched(pool, input);
    },

    completeConnectionTest: (input) =>
      completePersistedConnectionTest(pool, input),

    abandonConnectionTest: (input) =>
      abandonPersistedConnectionTest(pool, input),
  });
}

async function startPersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['startConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['startConnectionTest']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const expectedProviderKey = providerKeySchema.parse(
    input.expectedProviderKey,
  );
  const requestHash = digestSchema.parse(input.requestHash);
  const digest = keyDigest(input.idempotencyKey);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const scope = connectionTestScope(actorId, connectionId);
  return withConnectionTransaction(
    pool,
    input.workspaceId,
    actorId,
    async (client, workspaceId) => {
      await requireConnectionUser(client, workspaceId, actorId, connectionId);
      const inserted = await client.query(
        `insert into app.idempotency_records
               (id, workspace_id, operation, scope, key_hash, request_hash,
                status, resource_id, result_ref)
             values ($1, $2, 'connection.test', $3, $4, $5, 'in_progress',
                     $6, $7::jsonb)
             on conflict (workspace_id, operation, scope, key_hash) do nothing
             returning id`,
        [
          generatePersistedId(),
          workspaceId,
          scope,
          digest,
          requestHash,
          connectionId,
          JSON.stringify(connectionTestClaim(dispatchToken, 'claimed')),
        ],
      );
      const claim = await client.query<{
        request_hash: string;
        result_ref: unknown;
        stale: boolean;
        status: string;
      }>(
        `select request_hash, status, result_ref,
                    updated_at < transaction_timestamp() - interval '2 minutes'
                      as stale
             from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 for update`,
        [workspaceId, scope, digest],
      );
      const current = claim.rows[0];
      if (current === undefined)
        throw new Error('Connection test idempotency claim is unavailable');
      if (current.request_hash !== requestHash)
        throw new ConnectionIdempotencyConflictError(
          'Idempotency key request mismatch',
        );
      if (current.status === 'completed') {
        const result = parseConnectionTestResult(current.result_ref);
        if (
          result.connection.workspaceId !== workspaceId ||
          result.connection.id !== connectionId
        )
          throw new Error('Connection test idempotency result is corrupt');
        return Object.freeze({ kind: 'replay' as const, result });
      }
      const ownsClaim = inserted.rowCount === 1;
      if (!ownsClaim) {
        if (
          current.status === 'in_progress' &&
          connectionTestClaimSchema.parse(current.result_ref).state ===
            'dispatched'
        )
          throw new ConnectionTestInProgressError(
            'Connection test has durable dispatch evidence',
          );
        if (current.status !== 'failed' && !current.stale)
          throw new ConnectionTestInProgressError(
            'Connection test is already in progress',
          );
        await client.query(
          `update app.idempotency_records
               set status = 'in_progress', result_ref = $1::jsonb,
                   updated_at = transaction_timestamp()
               where workspace_id = $2 and operation = 'connection.test'
                 and scope = $3 and key_hash = $4`,
          [
            JSON.stringify(connectionTestClaim(dispatchToken, 'claimed')),
            workspaceId,
            scope,
            digest,
          ],
        );
      }

      const connection = await selectConnection(
        client,
        workspaceId,
        connectionId,
      );
      if (
        connection?.providerKey !== expectedProviderKey ||
        connection.status === CONNECTION_STATUS.revoked
      )
        throw new ConnectionUnavailableError(
          'Connection is not available for testing',
        );
      return Object.freeze({
        kind: 'dispatch' as const,
        dispatchToken,
      });
    },
  );
}

async function resolvePersistedConnectionTestSecret(
  pool: Pool,
  input: Parameters<
    ConnectionTestPersistence['resolveConnectionTestSecret']
  >[0],
): ReturnType<ConnectionTestPersistence['resolveConnectionTestSecret']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const expectedProviderKey = providerKeySchema.parse(
    input.expectedProviderKey,
  );
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  const metadata = parseRequestMetadata(input);
  return withConnectionTransaction(
    pool,
    input.workspaceId,
    actorId,
    async (client, workspaceId) => {
      await requireConnectionUser(client, workspaceId, actorId, connectionId);
      const claim = await client.query(
        `select 1 from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5
               and result_ref->>'state' = 'claimed' for update`,
        [workspaceId, scope, digest, requestHash, dispatchToken],
      );
      if (claim.rowCount !== 1)
        throw new ConnectionTestInProgressError(
          'Connection test credential ownership was lost',
        );
      const resolved = await client.query<
        Record<string, unknown> & { test_health_revision: string }
      >(
        `select connection.*,
                    connection.health_revision::text as test_health_revision,
                    secret.id as secret_id,
                    secret.kms_key_reference,
                    secret.encrypted_data_key,
                    secret.ciphertext,
                    secret.nonce,
                    secret.auth_tag
             from app.connections connection
             join app.connection_secret_versions secret
               on secret.workspace_id = connection.workspace_id
              and secret.connection_id = connection.id
              and secret.id = connection.current_secret_version_id
             where connection.workspace_id = $1 and connection.id = $2
               and connection.provider_key = $3
               and connection.status <> 'revoked'
             for share of connection`,
        [workspaceId, connectionId, expectedProviderKey],
      );
      const row = resolved.rows[0];
      if (row === undefined)
        throw new ConnectionUnavailableError(
          'Connection is not available for testing',
        );
      const connection = mapConnection(row);
      const secretVersionId = uuidSchema.parse(row.secret_id);
      if (secretVersionId !== connection.currentSecretVersionId)
        throw new Error('Connection secret pointer is corrupt');
      // DNS and safety checks may fail before dispatch. Capture their
      // current-credential fence now, without inventing dispatch evidence.
      await client.query(
        `update app.idempotency_records
             set result_ref = $1::jsonb, updated_at = transaction_timestamp()
             where workspace_id = $2 and operation = 'connection.test'
               and scope = $3 and key_hash = $4`,
        [
          JSON.stringify(
            connectionTestClaim(
              dispatchToken,
              'claimed',
              secretVersionId,
              row.test_health_revision,
            ),
          ),
          workspaceId,
          scope,
          digest,
        ],
      );
      await client.query(
        `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.credential_accessed', 'user',
                     $4, $5, $6, $7::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          connectionId,
          actorId,
          metadata.requestId,
          metadata.traceId,
          JSON.stringify({
            purpose: 'connection.test',
            secretVersionId,
          }),
        ],
      );
      return Object.freeze({
        connection,
        secretVersionId,
        sealed: mapSealed(row),
      });
    },
  );
}

async function completePersistedConnectionTest(
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
  return withConnectionTransaction(
    pool,
    input.workspaceId,
    actorId,
    async (client, workspaceId) => {
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
      if (
        (outcome.ok ||
          outcome.httpStatus !== null ||
          outcome.reauthorizationRequired) &&
        claimState.state !== 'dispatched'
      )
        throw new ConnectionTestInProgressError(
          'Connection test has no dispatch evidence',
        );
      const current = await selectConnection(
        client,
        workspaceId,
        connectionId,
        true,
      );
      if (current === null)
        throw new ConnectionNotFoundError('Connection is not visible');

      const currentSecretWasTested =
        current.currentSecretVersionId === secretVersionId;
      const classification = classifyConnectionTestCompletion(
        current.status,
        outcome,
        secretVersionId,
        currentSecretWasTested,
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
  );
}

async function abandonPersistedConnectionTest(
  pool: Pool,
  input: Parameters<ConnectionTestPersistence['abandonConnectionTest']>[0],
): ReturnType<ConnectionTestPersistence['abandonConnectionTest']> {
  const actorId = uuidSchema.parse(input.actorId);
  const connectionId = uuidSchema.parse(input.connectionId);
  const requestHash = digestSchema.parse(input.requestHash);
  const dispatchToken = uuidSchema.parse(input.dispatchToken);
  const digest = keyDigest(input.idempotencyKey);
  const scope = connectionTestScope(actorId, connectionId);
  await withConnectionTransaction(
    pool,
    input.workspaceId,
    actorId,
    async (client, workspaceId) => {
      await client.query(
        `update app.idempotency_records
             set status = 'failed',
                 result_ref = '{"state":"failed"}'::jsonb,
                 updated_at = transaction_timestamp()
             where workspace_id = $1 and operation = 'connection.test'
                and scope = $2 and key_hash = $3 and request_hash = $4
                and status = 'in_progress'
                and result_ref->>'dispatchToken' = $5
                and result_ref->>'state' = 'claimed'`,
        [workspaceId, scope, digest, requestHash, dispatchToken],
      );
    },
  );
}
