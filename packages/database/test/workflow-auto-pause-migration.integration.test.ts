import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { createWorkflowTriggerPauseFoldStore } from '../src/execution/trigger-pause/trigger-pause-fold-store.js';
import { parseDatabaseConfig } from '../src/config.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import {
  copyMigrationsBefore,
  createArtifactMigrationConfig,
} from './support/artifact-migration-fixture.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

describe('auto pause controls prior-head migration and readiness', () => {
  it('upgrades retained pause/streak/outcomes from 0124 and detects owner-command drift', async () => {
    const fixture = createDisposableDatabaseFixture({
      adminUrl,
      connectRoles: ['pertexo_migration', 'pertexo_api', 'pertexo_worker'],
      ownerRole: 'pertexo_owner',
      databaseName: `pertexo_test_pause_upgrade_${randomUUID().replaceAll('-', '')}`,
    });
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-pause-0124-'),
    );
    const owner = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    const api = new Pool({
      connectionString: fixture.databaseUrl(apiUrl),
      max: 1,
    });
    const fold = createWorkflowTriggerPauseFoldStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(workerUrl),
        max: 1,
      }),
    );
    try {
      await fixture.create();
      await copyMigrationsBefore(priorDirectory, '0125_');
      const config = createArtifactMigrationConfig(
        fixture.databaseUrl(migrationUrl),
      );
      expect((await migrateDatabase(config, priorDirectory)).at(-1)).toBe(
        '0124_workflow_trigger_pause.sql',
      );
      const actorId = randomUUID(),
        workspaceId = randomUUID(),
        workflowId = randomUUID(),
        runId = randomUUID();
      await owner.query(
        "insert into app.users(id,email,display_name,status) values($1,$2,'Owner','active')",
        [actorId, `${actorId}@example.test`],
      );
      await owner.query(
        "insert into app.workspaces(id,name,slug,status,created_by) values($1,'Retained pause',$2,'active',$3)",
        [workspaceId, `retained-${workspaceId}`, actorId],
      );
      await owner.query(
        `insert into app.workflows(id,workspace_id,name,created_by,trigger_pause_state,trigger_paused_at,
        trigger_pause_reason,trigger_pause_failures,trigger_pause_last_run_id,trigger_pause_revision)
        values($1,$2,'Retained workflow',$3,'paused',clock_timestamp(),'consecutive_failures',10,$4,9007199254740993)`,
        [workflowId, workspaceId, actorId, runId],
      );
      await owner.query(
        'insert into app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures) values($1,$2,12)',
        [workspaceId, workflowId],
      );
      await owner.query(
        `with tenant as(select set_config('app.workspace_id',$2::uuid::text,true))
        insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
        select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'schedule','failed' from tenant`,
        [runId, workspaceId, workflowId, randomUUID()],
      );
      await owner.query(
        `insert into app.workflow_trigger_outcomes(id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at)
        values($1,$2,$3,$4,true,clock_timestamp())`,
        [randomUUID(), workspaceId, workflowId, runId],
      );
      await copyMigrationsBefore(priorDirectory, '0126_');
      expect(await migrateDatabase(config, priorDirectory)).toEqual([
        '0125_workflow_auto_pause_controls.sql',
      ]);
      expect(
        (
          await owner.query(`select
        (select name from pertexo_internal.schema_migrations order by name desc limit 1) as head,
        to_regprocedure('app.workspace_reserved_active_slot_count(uuid)') as reader,
        to_regclass('app.workflow_run_active_admissions_workspace_idx') as reservation_index`)
        ).rows,
      ).toEqual([
        {
          head: '0125_workflow_auto_pause_controls.sql',
          reader: null,
          reservation_index: null,
        },
      ]);
      expect(await migrateDatabase(config)).toEqual([
        '0126_workspace_usage_capacity.sql',
        '0127_workflow_concurrency.sql',
        '0128_connection_health.sql',
        '0129_workflow_duplication.sql',
        '0130_workflow_input_cases.sql',
        '0131_checked_manual_start.sql',
        '0132_workflow_portability.sql',
        '0133_curated_template_origin.sql',
        '0134_workflow_organization.sql',
        '0135_workflow_folders_batch_identity.sql',
        '0136_workflow_draft_graph_v2.sql',
      ]);
      expect(await migrateDatabase(config)).toEqual([]);
      expect(
        (
          await owner.query(
            `select trigger_pause_state,trigger_pause_revision::text,auto_pause_settings_revision
        from app.workflows where id=$1`,
            [workflowId],
          )
        ).rows,
      ).toEqual([
        {
          trigger_pause_state: 'paused',
          trigger_pause_revision: '9007199254740993',
          auto_pause_settings_revision: 1,
        },
      ]);
      expect(
        (
          await owner.query(
            'select consecutive_failures,resumed_after from app.workflow_failure_streaks where workflow_id=$1',
            [workflowId],
          )
        ).rows,
      ).toEqual([{ consecutive_failures: 12, resumed_after: null }]);
      await expect(
        checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
      ).resolves.toMatchObject({
        migrationHead: '0136_workflow_draft_graph_v2.sql',
      });
      await expect(fold.checkReadiness()).resolves.toBeUndefined();
      const foldSignature =
        'app.fold_workflow_trigger_outcomes(integer,boolean)';
      const foldDefinition = (
        await owner.query<{ definition: string }>(
          'select pg_get_functiondef($1::regprocedure) as definition',
          [foldSignature],
        )
      ).rows[0]?.definition;
      if (foldDefinition === undefined) throw new Error('Missing fold command');
      try {
        await owner.query(
          foldDefinition.replace(
            'invalid trigger outcome fold parameters',
            'altered trigger outcome fold parameters',
          ),
        );
        await expect(fold.checkReadiness()).rejects.toThrow(
          'Workflow trigger pause authority is incompatible',
        );
      } finally {
        await owner.query(foldDefinition);
      }
      try {
        await owner.query(
          `grant execute on function ${foldSignature} to pertexo_api`,
        );
        await expect(fold.checkReadiness()).rejects.toThrow(
          'Workflow trigger pause authority is incompatible',
        );
      } finally {
        await owner.query(
          `revoke execute on function ${foldSignature} from pertexo_api`,
        );
      }
      await expect(fold.checkReadiness()).resolves.toBeUndefined();
      await fold.foldPending(1000, true);
      expect(
        (
          await owner.query<{ consecutive_failures: number }>(
            'select consecutive_failures from app.workflow_failure_streaks where workflow_id=$1',
            [workflowId],
          )
        ).rows[0]?.consecutive_failures,
      ).toBe(13);
      const signature =
        'app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)';
      const definition = (
        await owner.query<{ definition: string }>(
          'select pg_get_functiondef($1::regprocedure) as definition',
          [signature],
        )
      ).rows[0]?.definition;
      if (definition === undefined) throw new Error('Missing owner command');
      try {
        await owner.query(
          `alter function ${signature} set search_path=pg_catalog,app,public,pg_temp`,
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(definition);
      }
      try {
        await owner.query(
          `grant execute on function ${signature} to pertexo_worker`,
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(
          `revoke execute on function ${signature} from pertexo_worker`,
        );
      }
      try {
        await owner.query(
          definition.replace(
            'invalid auto pause operation',
            'altered auto pause operation',
          ),
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(definition);
      }
      try {
        await owner.query(
          'alter table app.workflow_auto_pause_command_receipts no force row level security',
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(
          'alter table app.workflow_auto_pause_command_receipts force row level security',
        );
      }
      await expect(
        checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
      ).resolves.toBeDefined();
      const admissionSignature =
        'app.schedule_claim_workflow_paused(uuid,uuid,timestamptz)';
      const admissionDefinition = (
        await owner.query<{ definition: string }>(
          'select pg_get_functiondef($1::regprocedure) as definition',
          [admissionSignature],
        )
      ).rows[0]?.definition;
      if (admissionDefinition === undefined)
        throw new Error('Missing pause admission command');
      try {
        await owner.query(
          admissionDefinition.replace(
            'scheduled instant required',
            'altered scheduled instant required',
          ),
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(admissionDefinition);
      }
      try {
        await owner.query(
          `grant execute on function ${admissionSignature} to pertexo_operator`,
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(
          `revoke execute on function ${admissionSignature} from pertexo_operator`,
        );
      }
      try {
        await owner.query(
          'alter table app.workflow_trigger_pause_periods no force row level security',
        );
        await expect(
          checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
        ).rejects.toThrow('Workflow authoring schema is incompatible');
      } finally {
        await owner.query(
          'alter table app.workflow_trigger_pause_periods force row level security',
        );
      }
      await expect(
        checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
      ).resolves.toBeDefined();
    } finally {
      await Promise.all([owner.end(), api.end(), fold.close()]);
      await fixture.drop();
      await rm(priorDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
