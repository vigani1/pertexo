import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  uuidSchema,
  identifierSchema,
  errorCodeSchema,
  CONNECTION_STATUS,
  CONNECTION_EVENT_TYPE,
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  mapConnection,
  withConnectionTransaction,
  parseRequestMetadata,
  selectConnection,
} from './connection-persistence.js';
import type {
  ConnectionDatabase,
  ConnectionRecord,
} from './connection-persistence.js';

/** Owns standalone connection health observations and status transitions. */

export type ConnectionHealthPersistence = Pick<
  ConnectionDatabase,
  'recordConnectionHealth'
>;

export function createConnectionHealthPersistence(
  pool: Pool,
): ConnectionHealthPersistence {
  return Object.freeze({
    recordConnectionHealth: async (input): Promise<ConnectionRecord> => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const actorId = identifierSchema.parse(input.actorId);
      const actorKind = z
        .enum(['user', 'worker', 'system'])
        .parse(input.actorKind);
      const metadata = parseRequestMetadata(input);
      const result = input.result.ok
        ? input.result
        : Object.freeze({
            ...input.result,
            errorCode: errorCodeSchema.parse(input.result.errorCode),
          });
      return withConnectionTransaction(
        pool,
        input.workspaceId,
        actorId,
        async (client, workspaceId) => {
          const connection = await selectConnection(
            client,
            workspaceId,
            connectionId,
            true,
          );
          if (connection === null)
            throw new ConnectionNotFoundError('Connection is not visible');
          if (connection.status === CONNECTION_STATUS.revoked)
            throw new ConnectionUnavailableError('Connection is revoked');
          const status =
            !result.ok && result.reauthorizationRequired === true
              ? CONNECTION_STATUS.reauthorizationRequired
              : connection.status;
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
              result.ok,
              result.ok ? null : result.errorCode,
              workspaceId,
              connectionId,
            ],
          );
          const eventType = result.ok
            ? CONNECTION_EVENT_TYPE.testSucceeded
            : result.reauthorizationRequired === true
              ? CONNECTION_EVENT_TYPE.reauthorizationRequired
              : CONNECTION_EVENT_TYPE.testFailed;
          await client.query(
            `insert into app.connection_events
               (id, workspace_id, connection_id, event_type, actor_kind,
                actor_id, request_id, trace_id, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              randomUUID(),
              workspaceId,
              connectionId,
              eventType,
              actorKind,
              actorId,
              metadata.requestId,
              metadata.traceId,
              JSON.stringify(result.ok ? {} : { errorCode: result.errorCode }),
            ],
          );
          const row = updated.rows[0];
          if (row === undefined)
            throw new Error('Connection health update returned no row');
          return mapConnection(row);
        },
      );
    },
  });
}
