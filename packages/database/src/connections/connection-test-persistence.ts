import { generatePersistedId } from '../persisted-id.js';

import type { Pool } from 'pg';
import {
  uuidSchema,
  digestSchema,
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
  requireConnectionUser,
  parseRequestMetadata,
  selectConnection,
  connectionTestOutcomeSchema,
  parseConnectionTestResult,
  serializeConnectionTestResult,
  connectionTestScope,
  connectionTestClaim,
  connectionTestClaimSchema,
} from './connection-persistence.js';
import type {
  ConnectionDatabase,
  ResolvedConnectionSecretRecord,
  StartConnectionTestResult,
  ConnectionTestResult,
} from './connection-persistence.js';

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
    startConnectionTest: async (input): Promise<StartConnectionTestResult> => {
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
          await requireConnectionUser(client, workspaceId, actorId);
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
          if (current.status === 'completed')
            return Object.freeze({
              kind: 'replay' as const,
              result: parseConnectionTestResult(current.result_ref),
            });
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
            connection.status !== CONNECTION_STATUS.active
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
    },

    resolveConnectionTestSecret: async (
      input,
    ): Promise<ResolvedConnectionSecretRecord> => {
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
          await requireConnectionUser(client, workspaceId, actorId);
          const claim = await client.query(
            `select 1 from app.idempotency_records
             where workspace_id = $1 and operation = 'connection.test'
               and scope = $2 and key_hash = $3 and request_hash = $4
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $5 for share`,
            [workspaceId, scope, digest, requestHash, dispatchToken],
          );
          if (claim.rowCount !== 1)
            throw new ConnectionTestInProgressError(
              'Connection test credential ownership was lost',
            );
          const resolved = await client.query<Record<string, unknown>>(
            `select connection.*,
                    secret.id as secret_id,
                    secret.schema_version,
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
               and connection.status = 'active'
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
    },

    markConnectionTestDispatched: async (input): Promise<void> => {
      const actorId = uuidSchema.parse(input.actorId);
      const connectionId = uuidSchema.parse(input.connectionId);
      const secretVersionId = uuidSchema.parse(input.secretVersionId);
      const requestHash = digestSchema.parse(input.requestHash);
      const dispatchToken = uuidSchema.parse(input.dispatchToken);
      const digest = keyDigest(input.idempotencyKey);
      const scope = connectionTestScope(actorId, connectionId);
      const metadata = parseRequestMetadata(input);
      await withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          await requireConnectionUser(client, workspaceId, actorId);
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
          );
          if (
            connection?.status !== CONNECTION_STATUS.active ||
            connection.currentSecretVersionId !== secretVersionId
          )
            throw new ConnectionUnavailableError(
              'Connection changed before test dispatch',
            );
          const marked = await client.query(
            `update app.idempotency_records
             set result_ref = $1::jsonb, updated_at = transaction_timestamp()
             where workspace_id = $2 and operation = 'connection.test'
               and scope = $3 and key_hash = $4 and request_hash = $5
               and status = 'in_progress'
               and result_ref->>'dispatchToken' = $6`,
            [
              JSON.stringify(connectionTestClaim(dispatchToken, 'dispatched')),
              workspaceId,
              scope,
              digest,
              requestHash,
              dispatchToken,
            ],
          );
          if (marked.rowCount !== 1)
            throw new ConnectionTestInProgressError(
              'Connection test dispatch ownership was lost',
            );
          await client.query(
            `insert into app.audit_events
               (id, workspace_id, actor_user_id, action, target_type,
                target_id, request_id, trace_id, metadata)
             values ($1, $2, $3, 'connection.test_dispatched', 'connection',
                     $4, $5, $6, $7::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              actorId,
              connectionId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify({ secretVersionId }),
            ],
          );
        },
      );
    },

    completeConnectionTest: async (input): Promise<ConnectionTestResult> => {
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
            (outcome.ok || outcome.httpStatus !== null) &&
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

          let connection = current;
          const currentSecretWasTested =
            current.currentSecretVersionId === secretVersionId;
          if (
            current.status !== CONNECTION_STATUS.revoked &&
            currentSecretWasTested
          ) {
            const status = outcome.ok
              ? CONNECTION_STATUS.active
              : outcome.reauthorizationRequired
                ? CONNECTION_STATUS.reauthorizationRequired
                : current.status;
            const updated = await client.query<Record<string, unknown>>(
              `update app.connections
               set status = $1,
                   last_tested_at = transaction_timestamp(),
                   last_healthy_at = case when $2 then transaction_timestamp()
                                          else last_healthy_at end,
                   last_error_code = $3,
                   updated_at = transaction_timestamp()
               where workspace_id = $4 and id = $5 returning *`,
              [
                status,
                outcome.ok,
                outcome.ok ? null : outcome.errorCode,
                workspaceId,
                connectionId,
              ],
            );
            const row = updated.rows[0];
            if (row === undefined)
              throw new Error('Connection test health update returned no row');
            connection = mapConnection(row);
          }
          const eventType = outcome.ok
            ? CONNECTION_EVENT_TYPE.testSucceeded
            : outcome.reauthorizationRequired
              ? CONNECTION_EVENT_TYPE.reauthorizationRequired
              : CONNECTION_EVENT_TYPE.testFailed;
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, $4, 'user', $5, $6, $7, $8::jsonb)`,
            [
              generatePersistedId(),
              workspaceId,
              connectionId,
              eventType,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify(
                outcome.ok
                  ? {
                      httpStatus: outcome.httpStatus,
                      secretVersionId,
                      currentSecretWasTested,
                    }
                  : {
                      errorCode: outcome.errorCode,
                      httpStatus: outcome.httpStatus,
                      secretVersionId,
                      currentSecretWasTested,
                    },
              ),
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
    },

    abandonConnectionTest: async (input): Promise<void> => {
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
                 result_ref = '{"schemaVersion":1,"state":"failed"}'::jsonb,
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
    },
  });
}
