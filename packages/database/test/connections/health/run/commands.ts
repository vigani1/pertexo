import type { ConnectionTestOutcome } from '../../../../src/connections/contract.js';
import { randomUUID } from 'node:crypto';
import { createOutboxDispatcherDatabase } from '../../../../src/outbox/dispatcher/database.js';
import type { PoolClient } from 'pg';

import {
  actorId,
  asAdmin,
  asOwner,
  databaseUrl,
  parseDatabaseConfig,
  workspaceA,
} from '../../../runs/run-store/fixtures.js';
import {
  sealedHealthSecret,
  withHealthApi,
  type HealthConnectionFixture,
} from './base.js';

export async function testHealthConnection(
  connection: HealthConnectionFixture,
  outcome: 'success' | 'rejection' | 'inconclusive' = 'success',
  afterDispatch?: () => Promise<void>,
) {
  const common = {
    workspaceId: workspaceA,
    actorId,
    connectionId: connection.connectionId,
    idempotencyKey: `test-${randomUUID()}`,
    dispatchToken: randomUUID(),
    requestHash: 'b'.repeat(64),
    secretVersionId: connection.secretVersionId,
  };
  return withHealthApi(async (api) => {
    await api.startConnectionTest({ ...common, expectedProviderKey: 'slack' });
    await api.resolveConnectionTestSecret({
      ...common,
      expectedProviderKey: 'slack',
    });
    await api.markConnectionTestDispatched(common);
    await afterDispatch?.();
    let testOutcome: ConnectionTestOutcome;
    if (outcome === 'success') {
      testOutcome = { ok: true, httpStatus: 200 };
    } else {
      if (outcome === 'inconclusive') {
        testOutcome = {
          ok: false,
          httpStatus: null,
          errorCode: 'connection.transport_failed',
          reauthorizationRequired: false,
        };
      } else {
        testOutcome = {
          ok: false,
          httpStatus: 200,
          errorCode: 'connection.slack_token_revoked',
          reauthorizationRequired: true,
        };
      }
    }
    return api.completeConnectionTest({
      ...common,
      outcome: testOutcome,
    });
  });
}

export async function rotateHealthConnection(
  connection: HealthConnectionFixture,
) {
  const secretVersionId = randomUUID();
  await withHealthApi((api) =>
    api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId,
      connectionId: connection.connectionId,
      expectedCurrentSecretVersionId: connection.secretVersionId,
      expectedAuthType: 'slack_bot_token',
      secretVersionId,
      sealed: sealedHealthSecret(2),
      idempotencyKey: `rotate-${randomUUID()}`,
      requestHash: 'c'.repeat(64),
    }),
  );
  return { ...connection, secretVersionId };
}

export async function revokeHealthConnection(
  connection: HealthConnectionFixture,
) {
  await withHealthApi((api) =>
    api.revokeConnection({
      workspaceId: workspaceA,
      actorId,
      connectionId: connection.connectionId,
    }),
  );
}

export async function withConnectionLock<T>(
  connectionId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  return asOwner(workspaceA, async (client) => {
    await client.query(
      'select id from app.connections where workspace_id=$1 and id=$2 for update',
      [workspaceA, connectionId],
    );
    return operation(client);
  });
}

export function createHealthDispatcher() {
  return createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(
        process.env.DATABASE_MAINTENANCE_URL ??
          'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
      ),
    }),
  );
}

/** A fault on one fixture-owned row; normal runtime adapters still perform every write. */
export async function withHealthWriteFailure(
  target: 'publication' | 'transition',
  id: string,
  operation: () => Promise<void>,
) {
  if (!/^[\da-f-]{36}$/u.test(id)) throw new Error('Invalid fixture fault ID');
  const table =
    target === 'publication' ? 'outbox_events' : 'connection_events';
  const condition =
    target === 'publication'
      ? `NEW.id='${id}'::uuid AND NEW.published_at IS NOT NULL`
      : `NEW.connection_id='${id}'::uuid AND NEW.event_type='connection.reauthorization_required'`;
  await asAdmin(async (client) => {
    await client.query(`CREATE FUNCTION app.f30_owned_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'controlled F30 write failure' USING ERRCODE='40001'; END $$`);
    await client.query(`CREATE TRIGGER f30_owned_write_failure BEFORE ${target === 'publication' ? 'UPDATE' : 'INSERT'}
      ON app.${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION app.f30_owned_write_failure()`);
  });
  try {
    await operation();
  } finally {
    await asAdmin(async (client) => {
      await client.query(
        `DROP TRIGGER f30_owned_write_failure ON app.${table}`,
      );
      await client.query('DROP FUNCTION app.f30_owned_write_failure()');
    });
  }
}
