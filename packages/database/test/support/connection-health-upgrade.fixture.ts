import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';

import { parseDatabaseConfig } from '../../src/config.js';
import { createApiConnectionDatabase } from '../../src/connections/connections.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { createDisposableDatabaseFixture } from './disposable-database.js';

export function createConnectionHealthUpgradeFixture() {
  const migrationBase =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const apiBase =
    process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
  const databaseName = `pertexo_test_health_upgrade_${randomUUID().replaceAll('-', '')}`;
  const fixture = createDisposableDatabaseFixture({
    adminUrl:
      process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
    connectRoles: ['pertexo_migration', 'pertexo_api'],
    databaseName,
    ownerRole: 'pertexo_owner',
  });
  const config = {
    connectionString: fixture.databaseUrl(migrationBase),
    ownerRole: 'pertexo_owner',
    apiRuntimeRole: 'pertexo_api',
    workerRuntimeRole: 'pertexo_worker',
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
  } as const;
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  const dispatchToken = randomUUID();
  const historicalTime = new Date('2026-07-01T00:00:00.000Z');
  const idempotencyKey = `legacy-${connectionId}`;
  const requestHash = 'b'.repeat(64);
  let directory: string | undefined;
  let created = false;

  const asOwner = async <T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    workspaceId,
    connectionId,
    historicalTime,
    asOwner,
    create: async () => {
      await fixture.create();
      created = true;
      directory = await mkdtemp(path.join(tmpdir(), 'pertexo-health-prior-'));
      for (const name of await readdir(MIGRATIONS_DIRECTORY))
        if (/^\d{4}_.+\.sql$/u.test(name) && name < '0128_')
          await copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(directory, name),
          );
      const applied = await migrateDatabase(config, directory);
      if (applied.at(-1) !== '0127_workflow_concurrency.sql')
        throw new Error('Connection health upgrade must begin at exact 0127');
      await asOwner(async (client) => {
        await client.query(
          `insert into app.users(id,email,display_name) values($1,$2,'Health upgrade')`,
          [actorId, `${actorId}@example.test`],
        );
        await client.query(
          `insert into app.workspaces(id,name,slug,created_by) values($1,'Health upgrade',$2,$3)`,
          [workspaceId, `health-${workspaceId}`, actorId],
        );
        await client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')`,
          [workspaceId, actorId],
        );
        await client.query(
          `insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by,last_tested_at,last_healthy_at,last_error_code)
          values($1,$2,'slack','Retained Slack','slack_bot_token','active',$3,$4,$5,$5,'connection.historical_test')`,
          [connectionId, workspaceId, secretVersionId, actorId, historicalTime],
        );
        await client.query(
          `insert into app.connection_secret_versions(id,workspace_id,connection_id,schema_version,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
          values($1,$2,$3,1,'kms:owned-upgrade','a','b',$4,$5,$6)`,
          [
            secretVersionId,
            workspaceId,
            connectionId,
            'a'.repeat(16),
            'b'.repeat(22),
            actorId,
          ],
        );
        await client.query(
          `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
          values($1,$2,'connection.test',$3,$4,$5,'in_progress',$6,$7::jsonb)`,
          [
            randomUUID(),
            workspaceId,
            `${actorId}:${connectionId}`,
            createHash('sha256').update(idempotencyKey).digest('hex'),
            requestHash,
            connectionId,
            JSON.stringify({
              schemaVersion: 1,
              state: 'dispatched',
              dispatchToken,
              secretVersionId,
            }),
          ],
        );
        await client.query(
          `insert into app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,metadata,created_at)
          values($1,$2,$3,'connection.test_failed','user',$4,'{"errorCode":"connection.historical_test"}',$5)`,
          [randomUUID(), workspaceId, connectionId, actorId, historicalTime],
        );
      });
    },
    upgrade: () => migrateDatabase(config),
    completeLegacy: async () => {
      const api = createApiConnectionDatabase(
        parseDatabaseConfig({ connectionString: fixture.databaseUrl(apiBase) }),
      );
      try {
        return await api.completeConnectionTest({
          workspaceId,
          actorId,
          connectionId,
          secretVersionId,
          dispatchToken,
          idempotencyKey,
          requestHash,
          outcome: { ok: true, httpStatus: 200 },
        });
      } finally {
        await api.close();
      }
    },
    close: async () => {
      const failures: unknown[] = [];
      try {
        await pool.end();
      } catch (error: unknown) {
        failures.push(error);
      }
      if (directory !== undefined)
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error: unknown) {
          failures.push(error);
        }
      if (created)
        try {
          await fixture.drop();
        } catch (error: unknown) {
          failures.push(error);
        }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Connection health upgrade cleanup failed',
        );
    },
  };
}
