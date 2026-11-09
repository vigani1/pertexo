import { expectedMigrationsAfter } from '../../src/testing/expected-migrations.js';
import { Pool } from 'pg';
import { withTenantScopedClient } from '../../src/tenant-access/transactions.js';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedReferenceIndexOwners } from '../artifacts/reference-index.fixture.js';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';

it('upgrades populated 0116 data without loss and preserves app workspace isolation', async () => {
  await withUpgradeDatabase(116, async ({ admin, upgrade }) => {
    const scopes = [
      await seedReferenceIndexOwners(admin),
      await seedReferenceIndexOwners(admin),
    ] as const;
    for (const scope of scopes)
      await admin.query(
        `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
       values($1,$2,'advance-workflow-run','workflow-run',$3,'{}',repeat('a',64))`,
        [randomUUID(), scope.workspaceId, scope.runId],
      );
    const tables = [
      'workflow_runs',
      'node_runs',
      'node_attempts',
      'outbox_events',
      'artifacts',
    ];
    const snapshot = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (
              await admin.query<{ row: unknown }>(
                `select to_jsonb(t) row from app.${table} t order by id`,
              )
            ).rows,
        ),
      );
    const before = await snapshot();
    for (const rows of before) expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(await upgrade()).toEqual(await expectedMigrationsAfter(116));
    expect(await snapshot()).toEqual(before);
    const client = await admin.connect();
    try {
      for (const table of tables) {
        await client.query("select set_config('app.workspace_id','',false)");
        await client.query('begin');
        await client.query('set local role pertexo_app');
        expect(
          (await client.query(`select workspace_id from app.${table}`)).rows,
        ).toEqual([]);
        await client.query("select set_config('app.workspace_id',$1,true)", [
          scopes[0].workspaceId,
        ]);
        const rows = (
          await client.query(`select workspace_id from app.${table}`)
        ).rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.every(
            (row: { workspace_id: string }) =>
              row.workspace_id === scopes[0].workspaceId,
          ),
        ).toBe(true);
        await client.query('rollback');
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 120_000);

it('refuses policy removal when the selected maintenance role lacks BYPASSRLS', async () => {
  await withUpgradeDatabase(116, async ({ admin, config, directory }) => {
    const role = 'pertexo_test_maintenance_' + randomUUID().replaceAll('-', '');
    await admin.query(`create role "${role}" nologin nobypassrls`);
    try {
      const before = (
        await admin.query(
          "select policyname,qual,with_check from pg_policies where schemaname='app' order by policyname",
        )
      ).rows;
      await copyFile(
        join(MIGRATIONS_DIRECTORY, '0117_row_security.sql'),
        join(directory, '0117_row_security.sql'),
      );
      await expect(
        migrateDatabase({ ...config, maintenanceRole: role }, directory),
      ).rejects.toThrow('requires BYPASSRLS');
      expect(
        (
          await admin.query(
            "select policyname,qual,with_check from pg_policies where schemaname='app' order by policyname",
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await admin.query(
            'select max(name) head from pertexo_internal.schema_migrations',
          )
        ).rows,
      ).toEqual([{ head: '0116_smtp_and_server_mail.sql' }]);
    } finally {
      await admin.query(`drop role "${role}"`);
    }
  });
}, 120_000);

it('rejects malformed workspace input at the app context writer and leaves the pooled session unscoped', async () => {
  await withUpgradeDatabase(117, async ({ config }) => {
    const url = new URL(
      process.env.DATABASE_URL ??
        'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    );
    url.pathname = new URL(config.connectionString).pathname;
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      await expect(
        withTenantScopedClient(pool, { workspaceId: 'malformed' }, (client) =>
          client.query("select current_setting('app.workspace_id',true)"),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(
        (
          await pool.query(
            "select current_user role,nullif(current_setting('app.workspace_id',true),'') workspace",
          )
        ).rows,
      ).toEqual([{ role: 'pertexo_app', workspace: null }]);
    } finally {
      await pool.end();
    }
  });
}, 120_000);

it('keeps global maintenance claims and schedule retirement unavailable to the app login', async () => {
  await withUpgradeDatabase(117, async ({ config }) => {
    const url = new URL(
      process.env.DATABASE_URL ??
        'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    );
    url.pathname = new URL(config.connectionString).pathname;
    const app = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      for (const statement of [
        'select app.claim_due_node_run_wakeups(1)',
        'select app.claim_due_workflow_run_deadlines(1)',
        "select * from app.claim_due_trigger_schedules('test',1,30)",
        'select * from app.discover_due_coordinated_events(1)',
        'select * from app.claim_workspace_inbox_events(1)',
        'select * from app.claim_due_run_failure_notification_recoveries(1)',
        'select app.release_trigger_schedule_claim(null::uuid,null::uuid)',
        "select app.store_trigger_schedule_retirement(null::uuid,null::uuid,'degraded','schedule.scan_failed',null::timestamptz)",
      ])
        await expect(app.query(statement), statement).rejects.toMatchObject({
          code: '42501',
        });
    } finally {
      await app.end();
    }
  });
}, 120_000);
