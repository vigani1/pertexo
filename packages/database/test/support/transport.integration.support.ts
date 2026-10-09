import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Pool, type PoolClient } from 'pg';

import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { createOutboxDispatcherDatabase } from '../../src/outbox/dispatcher/database.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createOperatorCommandDatabase } from '../../src/operator/commands.js';
import { createDisposableDatabaseFixture } from './disposable-database.js';

function deferredHandle<T extends object>(resolve: () => T): T {
  return new Proxy(Object.create(null) as T, {
    get: (_target, property) => {
      const resource = resolve();
      const value = Reflect.get(resource, property) as unknown;
      if (typeof value !== 'function') return value;
      return (...arguments_: unknown[]): unknown =>
        Reflect.apply(value, resource, arguments_) as unknown;
    },
  });
}

export function createTransportTestEnvironment() {
  const sharedDatabase = process.env.PERTEXO_Q11_SHARED_DATABASE === '1';
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const migrationBaseUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const apiBaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const workerBaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const dispatcherBaseUrl =
    process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
  const operatorBaseUrl =
    process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
  const databaseName = `pertexo_test_transport_${randomUUID().replaceAll('-', '')}`;
  const disposableDatabase = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
    databaseName,
    ownerRole: 'pertexo_owner',
  });
  const testUrl = (base: string): string =>
    sharedDatabase ? base : disposableDatabase.databaseUrl(base);
  const migrationUrl = testUrl(migrationBaseUrl);
  const apiUrl = testUrl(apiBaseUrl);
  const workerUrl = testUrl(workerBaseUrl);
  const dispatcherUrl = testUrl(dispatcherBaseUrl);
  const operatorUrl = testUrl(operatorBaseUrl);

  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const fixtureUserId = randomUUID();
  const checksumA = createHash('sha256').update('payload-a').digest('hex');
  const checksumB = createHash('sha256').update('payload-b').digest('hex');

  type ApiDatabase = ReturnType<typeof createWorkspaceDatabase>;
  type Dispatcher = ReturnType<typeof createOutboxDispatcherDatabase>;
  type Operator = ReturnType<typeof createOperatorCommandDatabase>;
  let apiDatabaseResource: ApiDatabase | undefined;
  let workerDatabaseResource: ApiDatabase | undefined;
  let dispatcherResource: Dispatcher | undefined;
  let operatorResource: Operator | undefined;
  let operatorReplicaResource: Operator | undefined;
  const required = <T>(resource: T | undefined, name: string): T => {
    if (resource === undefined)
      throw new Error(`Transport fixture ${name} is not initialized`);
    return resource;
  };
  const apiDatabase = deferredHandle(() =>
    required(apiDatabaseResource, 'API database'),
  );
  const workerDatabase = deferredHandle(() =>
    required(workerDatabaseResource, 'worker database'),
  );
  const dispatcher = deferredHandle(() =>
    required(dispatcherResource, 'dispatcher'),
  );
  const operator = deferredHandle(() => required(operatorResource, 'operator'));
  const operatorReplica = deferredHandle(() =>
    required(operatorReplicaResource, 'operator replica'),
  );

  const closeResources = async (): Promise<unknown[]> => {
    const resources = [
      apiDatabaseResource,
      workerDatabaseResource,
      dispatcherResource,
      operatorResource,
      operatorReplicaResource,
    ].filter((resource): resource is NonNullable<typeof resource> =>
      Boolean(resource),
    );
    const outcomes = await Promise.allSettled(
      resources.map((resource) => resource.close()),
    );
    return outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
  };

  const migrationConfig = {
    appRole: 'pertexo_app',
    connectionString: migrationUrl,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  } as const;

  const applyProofFixture = async (): Promise<void> => {
    const source = await readFile(
      new URL('../fixtures/queue-duplicate-proof.sql', import.meta.url),
      'utf8',
    );
    const fixture = source
      .replaceAll('{{api_runtime_role}}', 'pertexo_app')
      .replaceAll('{{worker_runtime_role}}', 'pertexo_app');
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
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
      await client?.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  };

  const reset = async (): Promise<void> => {
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query(`
        truncate table
          app.transport_security_audit_facts,
          app.operator_run_replay_requests,
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
      await client?.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  };

  return {
    apiDatabase,
    apiUrl,
    checksumA,
    checksumB,
    close: async (): Promise<void> => {
      const failures = await closeResources();
      if (!sharedDatabase) {
        try {
          await disposableDatabase.drop();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, 'Transport fixture cleanup failed');
    },
    dispatcher,
    dispatcherUrl,
    hasPostgresCode:
      (expectedCode: string) =>
      (error: unknown): boolean => {
        let current = error;
        const visited = new Set<object>();
        for (let depth = 0; depth < 16; depth += 1) {
          if (!(current instanceof Error) || visited.has(current)) return false;
          visited.add(current);
          try {
            if (Reflect.get(current, 'code') === expectedCode) return true;
            current = Reflect.get(current, 'cause');
          } catch {
            return false;
          }
        }
        return false;
      },
    initialize: async (): Promise<void> => {
      if (!sharedDatabase) await disposableDatabase.create();
      try {
        if (!sharedDatabase) await migrateDatabase(migrationConfig);
        await applyProofFixture();
        apiDatabaseResource = createWorkspaceDatabase(
          parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
        );
        workerDatabaseResource = createWorkspaceDatabase(
          parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
        );
        dispatcherResource = createOutboxDispatcherDatabase(
          parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 }),
        );
        operatorResource = createOperatorCommandDatabase(
          parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
        );
        operatorReplicaResource = createOperatorCommandDatabase(
          parseDatabaseConfig({ connectionString: operatorUrl, max: 1 }),
        );
      } catch (error: unknown) {
        const failures = [error, ...(await closeResources())];
        if (!sharedDatabase)
          try {
            await disposableDatabase.drop();
          } catch (cleanupError: unknown) {
            failures.push(cleanupError);
          }
        if (failures.length === 1) throw error;
        throw new AggregateError(failures, 'Transport fixture setup failed');
      }
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
