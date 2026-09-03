import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';

import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { createOutboxDispatcherDatabase } from '../../src/dispatcher.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createOperatorCommandDatabase } from '../../src/operator-commands.js';

export function createTransportTestEnvironment() {
  const migrationUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const apiUrl =
    process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
  const workerUrl =
    process.env.DATABASE_WORKER_URL ??
    'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
  const dispatcherUrl =
    process.env.DATABASE_DISPATCHER_URL ??
    'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
  const operatorUrl =
    process.env.DATABASE_OPERATOR_URL ??
    'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo';

  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const fixtureUserId = randomUUID();
  const checksumA = createHash('sha256').update('payload-a').digest('hex');
  const checksumB = createHash('sha256').update('payload-b').digest('hex');

  const apiDatabase = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  const workerDatabase = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
  );
  const dispatcher = createOutboxDispatcherDatabase(
    parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 }),
  );
  const operator = createOperatorCommandDatabase(
    parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
  );
  const operatorReplica = createOperatorCommandDatabase(
    parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
  );

  const migrationConfig = {
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;

  const applyProofFixture = async (): Promise<void> => {
    const source = await readFile(
      new URL('../fixtures/queue-duplicate-proof.sql', import.meta.url),
      'utf8',
    );
    const fixture = source
      .replaceAll('{{api_runtime_role}}', 'pertexo_api')
      .replaceAll('{{worker_runtime_role}}', 'pertexo_worker');
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query(fixture);
      await client.query(
        `insert into app.users(id,email,display_name) values($1,$2,'Transport fixture')
         on conflict(id) do nothing`,
        [fixtureUserId, `transport-${fixtureUserId}@example.test`],
      );
      await client.query(
        `insert into app.workspaces(id,name,slug,created_by)
         values($1,'Transport A',$3,$2),($4,'Transport B',$5,$2)
         on conflict(id) do nothing`,
        [
          workspaceA,
          fixtureUserId,
          `transport-a-${workspaceA}`,
          workspaceB,
          `transport-b-${workspaceB}`,
        ],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  };

  const reset = async (): Promise<void> => {
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query(`
        truncate table
          app.transport_security_audit_facts,
          app.operator_run_replay_requests,
          app.operator_maintenance_rerun_requests,
          app.operator_commands,
          app.audit_events,
          app.inbox_receipts,
          app.workflow_run_active_admissions,
          app.outbox_events,
          app.queue_duplicate_probe_attempts,
          app.queue_duplicate_probe_events,
          app.queue_duplicate_probe_usage,
          app.queue_duplicate_probe_provider_effects,
          app.queue_duplicate_probe_provider_intents,
          app.queue_duplicate_probe_acceptances
      `);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  };

  return {
    apiDatabase,
    checksumA,
    checksumB,
    close: () =>
      Promise.all([
        apiDatabase.close(),
        workerDatabase.close(),
        dispatcher.close(),
        operator.close(),
        operatorReplica.close(),
      ]).then(() => undefined),
    dispatcher,
    dispatcherUrl,
    hasPostgresCode:
      (expectedCode: string) =>
      (error: unknown): boolean => {
        let current = error;
        while (current instanceof Error) {
          if ('code' in current && current.code === expectedCode) return true;
          current = current.cause;
        }
        return false;
      },
    initialize: async (): Promise<void> => {
      await migrateDatabase(migrationConfig);
      await applyProofFixture();
    },
    migrationUrl,
    operator,
    operatorReplica,
    reset,
    workerDatabase,
    workspaceA,
    workspaceB,
  };
}
