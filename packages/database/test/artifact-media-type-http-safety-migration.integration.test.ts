import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_0085_artifact_media_${randomUUID().replaceAll('-', '')}`;
const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_dispatcher',
    'pertexo_maintenance',
    'pertexo_lifecycle_command',
    'pertexo_operator',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const { databaseUrl } = database;
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

beforeAll(database.create, 30_000);
afterAll(database.drop);

describe('artifact media-type HTTP safety prior-head migration', () => {
  it('fails closed on unsafe inventory, then enforces the aligned constraint', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-0084-artifact-media-'),
    );
    const workspaceId = randomUUID();
    const artifactId = randomUUID();
    const owner = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0085_',
      );
      await Promise.all(
        migrations.map((name) =>
          copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(priorDirectory, name),
          ),
        ),
      );
      const prior = await migrateDatabase(migrationConfig, priorDirectory);
      expect(prior.at(-1)).toBe('0084_workspace_member_discovery_index.sql');

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `insert into app.workspace_artifact_capacity
           (workspace_id,byte_limit,artifact_count_limit,charged_bytes,charged_count)
         values($1,1000,100,0,0)`,
        [workspaceId],
      );
      await owner.query(
        `insert into app.artifacts
           (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
            status,expires_at)
         values($1,$2,'user-upload',
           'workspaces/'||$2::uuid::text||'/artifacts/'||$1::uuid::text,
           $3,5,$4,'pending',clock_timestamp()+interval '15 minutes')`,
        [artifactId, workspaceId, 'application/js\u000bon', 'a'.repeat(64)],
      );
      await owner.query('commit');

      await expect(migrateDatabase(migrationConfig)).rejects.toThrow(
        /artifacts_media_type_format/u,
      );

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query('alter table app.artifacts disable trigger user');
      await owner.query(
        `update app.artifacts set media_type='application/json'
          where workspace_id=$1 and id=$2`,
        [workspaceId, artifactId],
      );
      await owner.query('alter table app.artifacts enable trigger user');
      await owner.query('commit');

      await expect(migrateDatabase(migrationConfig)).resolves.toEqual([
        '0085_artifact_media_type_http_safety.sql',
        '0086_operator_attempt_reclaim_state.sql',
      ]);

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query('alter table app.artifacts disable trigger user');
      await expect(
        owner.query(
          `update app.artifacts set media_type=$3
            where workspace_id=$1 and id=$2`,
          [workspaceId, artifactId, 'application/js\u007fon'],
        ),
      ).rejects.toThrow(/artifacts_media_type_format/u);
      await owner.query('rollback');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
      await rm(priorDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
