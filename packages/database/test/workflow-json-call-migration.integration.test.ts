import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { checkInlineWorkflowCallCoordinatorReadiness } from '../src/execution/coordinator/coordinator-native-readiness.js';
import {
  DATABASE_READINESS_SQL,
  type ReadinessRow,
} from '../src/platform/readiness-probe.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const migrationName = '0139_workflow_json_calls.sql';
const currentMigrationHead = '0141_native_attempt_lock_order.sql';
const retainedOwners = [
  'execute_standard_retention_page',
  'standard_retention_dry_run_stage_keys',
  'execute_workspace_tenant_rows_page',
  'find_due_run_artifact_retention',
  'prepare_run_artifact_retention',
  'complete_run_artifact_retention',
];

describe('registered inline workflow Call migration', () => {
  for (const upgraded of [false, true]) {
    it(
      upgraded
        ? 'upgrades populated 0136 without changing deferred owners'
        : 'installs on an empty database without deferred artifact storage',
      async () => {
        const fixture = createDisposableDatabaseFixture({
          adminUrl,
          databaseName: `pertexo_test_json_call_${randomUUID().replaceAll('-', '')}`,
          connectRoles: [
            'pertexo_migration',
            'pertexo_api',
            'pertexo_worker',
            'pertexo_dispatcher',
            'pertexo_operator',
          ],
          ownerRole: 'pertexo_owner',
        });
        await fixture.create();
        const priorDirectory = await mkdtemp(
          path.join(tmpdir(), 'pertexo-json-call-0136-'),
        );
        const pool = new Pool({
          connectionString: fixture.databaseUrl(adminUrl),
          max: 1,
        });
        const config = {
          connectionString: fixture.databaseUrl(migrationUrl),
          ownerRole: 'pertexo_owner',
          apiRuntimeRole: 'pertexo_api',
          workerRuntimeRole: 'pertexo_worker',
          dispatcherRole: 'pertexo_dispatcher',
          maintenanceRole: 'pertexo_maintenance',
          operatorRole: 'pertexo_operator',
          lifecycleCommandRole: 'pertexo_lifecycle_command',
        };
        try {
          const names = (await readdir(MIGRATIONS_DIRECTORY)).filter(
            (name) => /^\d{4}_.*\.sql$/u.test(name) && name < '0137_',
          );
          await Promise.all(
            names.map((name) =>
              copyFile(
                path.join(MIGRATIONS_DIRECTORY, name),
                path.join(priorDirectory, name),
              ),
            ),
          );
          let before: unknown;
          const userId = randomUUID();
          if (upgraded) {
            await migrateDatabase(config, priorDirectory);
            await pool.query(
              `insert into app.users(id,email,display_name,status,email_verified) values($1,$2,'Migration survivor','active',true)`,
              [userId, `${userId}@example.test`],
            );
            before = (
              await pool.query(
                `select proname,md5(prosrc) hash from pg_proc join pg_namespace on pg_namespace.oid=pronamespace where nspname='app' and proname=any($1) order by proname`,
                [retainedOwners],
              )
            ).rows;
          }
          const applied = await migrateDatabase(config);
          expect(applied.at(-1)).toBe(currentMigrationHead);
          if (upgraded) {
            expect(applied).toEqual([
              '0137_workflow_json_call_node_scope_index.sql',
              '0138_workflow_json_call_attempt_scope_index.sql',
              migrationName,
              '0140_workflow_call_controls.sql',
              currentMigrationHead,
            ]);
            expect(
              (
                await pool.query(
                  'select display_name from app.users where id=$1',
                  [userId],
                )
              ).rows,
            ).toEqual([{ display_name: 'Migration survivor' }]);
            expect(
              (
                await pool.query(
                  `select proname,md5(prosrc) hash from pg_proc join pg_namespace on pg_namespace.oid=pronamespace where nspname='app' and proname=any($1) order by proname`,
                  [retainedOwners],
                )
              ).rows,
            ).toEqual(before);
          }
          expect(
            (
              await pool.query(`select to_regclass('app.workflow_calls') is not null calls,
          to_regclass('app.workflow_execution_value_provenance') is not null provenance,
          to_regclass('app.workflow_execution_value_artifact_candidates') is null no_candidates,
          to_regclass('app.workflow_execution_value_artifact_associations') is null no_associations`)
            ).rows,
          ).toEqual([
            {
              calls: true,
              provenance: true,
              no_candidates: true,
              no_associations: true,
            },
          ]);
          expect(await migrateDatabase(config)).toEqual([]);
          for (const mutation of [
            'alter function app.native_execution_value_binary64_leaf(text) called on null input',
            "create or replace function app.executable_has_workflow_call(p_executable jsonb) returns boolean language sql immutable set search_path=pg_catalog,app,pg_temp as 'select false'",
            'grant execute on function app.set_workflow_calls_enabled(boolean) to pertexo_api',
            'alter table app.workflow_calls no force row level security',
            'alter table app.workflow_execution_value_provenance drop constraint native_value_call_declaration_scope_unique cascade',
            'alter table app.workflow_runs disable trigger aa_native_run_initiation',
          ]) {
            const client = await pool.connect();
            try {
              await client.query('begin');
              await client.query(mutation);
              await client.query('set local role pertexo_api');
              const metadata = await client.query<ReadinessRow>(
                DATABASE_READINESS_SQL,
                [
                  'pertexo_owner',
                  'pertexo_worker',
                  'pertexo_api',
                  'pertexo_maintenance',
                  'pertexo_operator',
                ],
              );
              expect(
                metadata.rows[0]?.workflow_calls_compatible,
                mutation,
              ).toBe(false);
            } finally {
              await client.query('rollback');
              client.release();
            }
          }
          const apiUrl = new URL(
            fixture.databaseUrl(
              process.env.DATABASE_API_URL ??
                'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
            ),
          );
          const api = new Pool({ connectionString: apiUrl.toString(), max: 1 });
          try {
            await expect(
              api.query('select app.assert_workflow_calls_enabled()'),
            ).rejects.toMatchObject({ code: '55000' });
            await expect(
              api.query('select app.set_workflow_calls_enabled(true)'),
            ).rejects.toMatchObject({ code: '42501' });
            await expect(
              api.query('update app.workflow_call_rollout set enabled=true'),
            ).rejects.toMatchObject({ code: '42501' });
            await expect(
              checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
            ).resolves.toMatchObject({
              migrationHead: currentMigrationHead,
              role: 'pertexo_api',
            });
          } finally {
            await api.end();
          }
          const workerUrl = new URL(apiUrl);
          workerUrl.username = 'pertexo_worker';
          workerUrl.password = 'pertexo-local-worker';
          const worker = new Pool({
            connectionString: fixture.databaseUrl(
              process.env.DATABASE_WORKER_URL ?? workerUrl.toString(),
            ),
            max: 1,
            connectionTimeoutMillis: 1000,
          });
          try {
            await expect(
              checkInlineWorkflowCallCoordinatorReadiness(
                worker,
                'pertexo_owner',
                'pertexo_worker',
                2000,
              ),
            ).resolves.toBeUndefined();
            await expect(
              checkDatabaseReadiness(worker, { ownerRole: 'pertexo_owner' }),
            ).resolves.toMatchObject({
              migrationHead: currentMigrationHead,
              role: 'pertexo_worker',
            });
          } finally {
            await worker.end();
          }
          expect(
            (
              await pool.query(
                'select enabled from app.workflow_call_rollout where singleton',
              )
            ).rows,
          ).toEqual([{ enabled: false }]);
          const actorId = randomUUID();
          const workspaceId = randomUUID();
          const workflowId = randomUUID();
          await pool.query(
            `insert into app.users(id,email,display_name,status,email_verified) values($1,$2,'Flag proof','active',true)`,
            [actorId, `${actorId}@example.test`],
          );
          await pool.query(
            `insert into app.workspaces(id,name,slug,status,created_by) values($1,'Flag proof',$2,'active',$3)`,
            [workspaceId, `flag-${workspaceId}`, actorId],
          );
          await pool.query(
            `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Flag proof',$3)`,
            [workflowId, workspaceId, actorId],
          );
          const publish = (nodes: unknown[], version: number) => {
            const graph = { schemaVersion: 2, nodes, edges: [], settings: {} };
            return pool.query(
              `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,schema_version,graph_json,checksum,executable_schema_version,executable_json,compatibility_release_epoch,published_by) values($1,$2,$3,$4,2,$5,$6,3,$7,1,$8)`,
              [
                randomUUID(),
                workspaceId,
                workflowId,
                version,
                graph,
                `wf:v3:sha256:${version.toString(16).repeat(64)}`,
                { schemaVersion: 3, graph },
                actorId,
              ],
            );
          };
          await expect(publish([], 1)).resolves.toMatchObject({ rowCount: 1 });
          const ordinaryVersion = (
            await pool.query(
              'select id from app.workflow_versions where workflow_id=$1 and version_number=1',
              [workflowId],
            )
          ).rows[0] as { id: string };
          const ordinaryRunId = randomUUID();
          await pool.query("select set_config('app.workspace_id',$1,false)", [
            workspaceId,
          ]);
          await expect(
            pool.query(
              `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'api','queued')`,
              [ordinaryRunId, workspaceId, workflowId, ordinaryVersion.id],
            ),
          ).resolves.toMatchObject({ rowCount: 1 });
          expect(
            (
              await pool.query(
                'select native_initiating_actor_id,native_initiating_role_revision from app.workflow_runs where id=$1',
                [ordinaryRunId],
              )
            ).rows,
          ).toEqual([
            {
              native_initiating_actor_id: null,
              native_initiating_role_revision: null,
            },
          ]);
          const call = {
            id: 'call',
            definition: { key: 'core.workflow_call', version: 1 },
            config: {},
          };
          await expect(publish([call], 2)).rejects.toMatchObject({
            code: '55000',
          });
          await expect(
            publish(
              [{ id: 'loop', structured: { body: { nodes: [call] } } }],
              2,
            ),
          ).rejects.toMatchObject({ code: '55000' });
          const operatorBase = new URL(migrationUrl);
          operatorBase.username = 'pertexo_operator';
          operatorBase.password = 'pertexo-local-operator';
          const operatorUrl = new URL(
            fixture.databaseUrl(
              process.env.DATABASE_OPERATOR_URL ?? operatorBase.toString(),
            ),
          );
          const operator = new Pool({
            connectionString: operatorUrl.toString(),
            max: 1,
          });
          try {
            await operator.query('select app.set_workflow_calls_enabled(true)');
            await expect(publish([call], 2)).resolves.toMatchObject({
              rowCount: 1,
            });
            await operator.query(
              'select app.set_workflow_calls_enabled(false)',
            );
            // Fresh manual roots require the full ordinary admission protocol.
            // The dedicated real HTTP qualification exercises their OFF refusal;
            // raw fixture INSERTs must not bypass the earlier admission fences.
            await expect(publish([], 3)).resolves.toMatchObject({
              rowCount: 1,
            });
          } finally {
            await operator.end();
          }
        } finally {
          await pool.end();
          await fixture.drop();
          await rm(priorDirectory, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
});
