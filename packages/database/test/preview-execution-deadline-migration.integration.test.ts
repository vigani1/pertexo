import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/platform/readiness.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_0070_deadline_${randomUUID().replaceAll('-', '')}`;

const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_dispatcher',
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

describe('preview execution deadline prior-head migration', () => {
  it('upgrades 0069 with the exact deadline schema and startup contract', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-0069-preview-deadline-'),
    );
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0070_',
      );
      await Promise.all(
        migrations.map((name) =>
          copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(priorDirectory, name),
          ),
        ),
      );
      await migrateDatabase(migrationConfig, priorDirectory);

      const owner = new Pool({
        connectionString: migrationConfig.connectionString,
        max: 1,
      });
      const actorUserId = randomUUID();
      const workspaceId = randomUUID();
      const workflowId = randomUUID();
      const shortPreviewRunId = randomUUID();
      const terminalPreviewRunId = randomUUID();
      const createdAt = new Date(Date.now() - 60_000);
      const shortExpiry = new Date(Date.now() + 60_000);
      const longExpiry = new Date(Date.now() + 60 * 60_000);
      try {
        const client = await owner.connect();
        try {
          await client.query('begin');
          await client.query('set local role pertexo_owner');
          await client.query('savepoint missing_deadline_probe');
          await expect(
            client.query(
              `select execution_deadline_at from app.preview_runs limit 1`,
            ),
          ).rejects.toMatchObject({ code: '42703' });
          await client.query('rollback to savepoint missing_deadline_probe');
          await client.query(
            `insert into app.users (id,email,display_name,status)
             values ($1,$2,'Deadline upgrade','active')`,
            [actorUserId, `deadline-${actorUserId}@example.test`],
          );
          await client.query(
            `insert into app.workspaces (id,name,slug,status,created_by)
             values ($1,'Deadline upgrade',$2,'active',$3)`,
            [workspaceId, `deadline-${workspaceId}`, actorUserId],
          );
          await client.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
          await client.query(
            `insert into app.workflows
               (id,workspace_id,name,lifecycle_status,activation_status,created_by)
             values ($1,$2,'Deadline target','active','inactive',$3)`,
            [workflowId, workspaceId, actorUserId],
          );
          const release = await client.query<{
            epoch: number;
            fingerprint: string;
          }>(
            `select epoch,fingerprint
             from app.node_compatibility_current where singleton=true`,
          );
          const current = release.rows[0];
          if (current === undefined)
            throw new Error('deadline fixture release missing');
          await client.query(
            `insert into app.preview_runs (
               id,workspace_id,workflow_id,draft_revision,draft_fingerprint,
               node_id,definition_key,definition_version,executor_key,
               executor_version,compatibility_release_epoch,
               compatibility_release_fingerprint,actor_user_id,
               idempotency_key_hash,request_hash,executable_node_json,input_ref,
               side_effect_class,may_contact_provider,
               may_cause_external_side_effect,dry_run,status,output_ref,
               safe_error_code,created_at,started_at,completed_at,expires_at
             ) values
               ($1,$2,$3,1,$4,'queued-node','core.set',1,'core.set',1,$5,$6,$7,
                $8,$9,'{"id":"queued-node"}'::jsonb,
                '{"schemaVersion":1,"kind":"inline","value":null}'::jsonb,
                'safe',false,false,'not_supported','queued',null,null,$10,null,null,$11),
               ($12,$2,$3,1,$13,'terminal-node','core.set',1,'core.set',1,$5,$6,$7,
                $14,$15,'{"id":"terminal-node"}'::jsonb,
                '{"schemaVersion":1,"kind":"inline","value":null}'::jsonb,
                'safe',false,false,'not_supported','failed',null,
                'preview.fixture_failed',$10,$10,$10,$16)`,
            [
              shortPreviewRunId,
              workspaceId,
              workflowId,
              'a'.repeat(64),
              current.epoch,
              current.fingerprint,
              actorUserId,
              'b'.repeat(64),
              'c'.repeat(64),
              createdAt,
              shortExpiry,
              terminalPreviewRunId,
              'd'.repeat(64),
              'e'.repeat(64),
              'f'.repeat(64),
              longExpiry,
            ],
          );
          await client.query('commit');
        } catch (error: unknown) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      } finally {
        await owner.end();
      }

      await migrateDatabase(migrationConfig);
      const api = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const ownerAfter = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        await expect(
          checkDatabaseReadiness(api, {
            ownerRole: 'pertexo_owner',
            workerRuntimeRole: 'pertexo_worker',
          }),
        ).resolves.toMatchObject({ migrationHead: EXPECTED_MIGRATION_HEAD });
        await expect(
          ownerAfter.query<{
            body_hash: string;
            constraint_definition: string;
          }>(
            `select
               md5(function.prosrc) body_hash,
               pg_get_constraintdef(constraint_record.oid) constraint_definition
             from pg_proc function
             cross join pg_constraint constraint_record
             where function.oid=to_regprocedure('app.reject_preview_run_pin_change()')
               and constraint_record.conrelid='app.preview_runs'::regclass
               and constraint_record.conname='preview_runs_execution_deadline_order'`,
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              body_hash: 'e3e80198979101aabfc681553bcdbedf',
              constraint_definition:
                'CHECK (((execution_deadline_at > created_at) AND (execution_deadline_at <= expires_at)))',
            },
          ],
        });
        const retained = await ownerAfter.query<{
          execution_deadline_at: Date;
          expires_at: Date;
          id: string;
          status: string;
        }>(
          `select id,status,execution_deadline_at,expires_at
           from app.preview_runs where id=any($1::uuid[]) order by id`,
          [[shortPreviewRunId, terminalPreviewRunId]],
        );
        expect(retained.rows).toHaveLength(2);
        expect(
          retained.rows
            .find(({ id }) => id === shortPreviewRunId)
            ?.execution_deadline_at.getTime(),
        ).toBe(shortExpiry.getTime());
        expect(
          retained.rows
            .find(({ id }) => id === terminalPreviewRunId)
            ?.execution_deadline_at.getTime(),
        ).toBe(createdAt.getTime() + 5 * 60_000);
        expect(
          retained.rows.find(({ id }) => id === terminalPreviewRunId)?.status,
        ).toBe('failed');
        await expect(
          ownerAfter.query(
            `update app.preview_runs set execution_deadline_at=expires_at
             where id=$1`,
            [terminalPreviewRunId],
          ),
        ).rejects.toMatchObject({ code: '55000' });

        const apiClient = await api.connect();
        try {
          await apiClient.query('begin');
          await apiClient.query(
            "select set_config('app.workspace_id',$1,true)",
            [randomUUID()],
          );
          await expect(
            apiClient.query<{ count: string }>(
              `select count(*)::text count from app.preview_runs
               where id=any($1::uuid[])`,
              [[shortPreviewRunId, terminalPreviewRunId]],
            ),
          ).resolves.toMatchObject({ rows: [{ count: '0' }] });
          await apiClient.query('commit');
        } catch (error: unknown) {
          await apiClient.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          apiClient.release();
        }
        await expect(migrateDatabase(migrationConfig)).resolves.toEqual([]);
      } finally {
        await Promise.all([api.end(), ownerAfter.end()]);
      }
    } finally {
      await rm(priorDirectory, { force: true, recursive: true });
    }
  }, 60_000);
});
