import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';

import type {
  AppendControlLedgerRecord,
  ControlLedger,
  ControlLedgerRecord,
} from '../../src/lifecycle/control-ledger-coordinator.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { dropDisconnectedDatabase } from './disposable-database.js';

const MIGRATIONS_AFTER_0045 = [
  '0046_workspace_deletion_control_projection.sql',
  '0047_workspace_lifecycle_command_intents.sql',
  '0048_workspace_lifecycle_command_hardening.sql',
  '0049_workspace_deletion_side_effects.sql',
  '0050_workspace_lifecycle_api_authority.sql',
  '0051_workflow_run_input_retention_dry_run.sql',
  '0052_workflow_run_input_retention_enforcement.sql',
  '0053_preview_retention_enforcement.sql',
  '0054_workflow_run_input_retention_scheduling.sql',
  '0055_standard_retention_classes.sql',
  '0056_workspace_purge_foundation.sql',
  '0057_workspace_tenant_rows_purge.sql',
  '0058_workspace_object_versions_purge.sql',
  '0059_workspace_purge_completion.sql',
  '0060_standard_retention_dry_run.sql',
  '0061_operator_outbox_redispatch.sql',
  '0062_operator_command_ledger.sql',
  '0063_operator_execution_recovery.sql',
  '0064_operator_trigger_reconciliation.sql',
  '0065_operator_run_replay.sql',
  '0066_operator_maintenance_rerun.sql',
  '0067_reconcile_published_migration_repairs.sql',
  '0068_restore_artifact_inventory.sql',
  '0069_regional_write_admission.sql',
  '0070_preview_execution_deadline.sql',
  '0071_oidc_browser_binding.sql',
  '0072_regional_replica_identity.sql',
  '0073_transient_data_retention.sql',
  '0075_workspace_purge_step_release.sql',
] as const;

export class MemoryLedger implements ControlLedger {
  public readonly records = new Map<string, ControlLedgerRecord[]>();
  public failAppend = false;
  public abortAfterAppend: AbortController | undefined;
  public hangReconcile = false;
  public reconcileStarted: (() => void) | undefined;

  public async append(
    input: AppendControlLedgerRecord,
  ): Promise<ControlLedgerRecord> {
    await Promise.resolve();
    input.signal?.throwIfAborted();
    if (this.failAppend) throw new Error('ledger unavailable');
    const records = this.records.get(input.workspaceId) ?? [];
    const existing = records.find(
      (record) => record.sequence === input.sequence,
    );
    if (existing !== undefined) return existing;
    const record: ControlLedgerRecord = {
      ...input,
      recordHash: input.sequence.toString(16).padStart(64, '0'),
      schemaVersion: 1,
    };
    delete (record as { signal?: AbortSignal }).signal;
    records.push(record);
    this.records.set(input.workspaceId, records);
    this.abortAfterAppend?.abort(new Error('simulated process interruption'));
    this.abortAfterAppend = undefined;
    return record;
  }

  public async reconcile(input: {
    maxRecords: number;
    projectedHash: string;
    projectedSequence: number;
    signal?: AbortSignal;
    workspaceId: string;
  }) {
    await Promise.resolve();
    input.signal?.throwIfAborted();
    this.reconcileStarted?.();
    if (this.hangReconcile)
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => {
            reject(
              input.signal?.reason instanceof Error
                ? input.signal.reason
                : new Error('Ledger reconciliation aborted'),
            );
          },
          { once: true },
        );
      });
    const all = this.records.get(input.workspaceId) ?? [];
    const records = all
      .filter((record) => record.sequence > input.projectedSequence)
      .slice(0, input.maxRecords);
    const last = records.at(-1);
    const hasMore = all.some(
      (record) => record.sequence > (last?.sequence ?? input.projectedSequence),
    );
    return {
      hasMore,
      pageEndHash: last?.recordHash ?? input.projectedHash,
      pageEndSequence: last?.sequence ?? input.projectedSequence,
      reachedHighWater: !hasMore,
      records,
    };
  }
}

async function createWorkspace(pool: Pool, id: string): Promise<string> {
  const userId = randomUUID();
  await pool.query('begin');
  try {
    await pool.query('set local role pertexo_owner');
    await pool.query("select set_config('app.workspace_id',$1,true)", [id]);
    await pool.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Ledger fixture')",
      [userId, `${userId}@example.test`],
    );
    await pool.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Ledger fixture',$2,$3)",
      [id, `ledger-${id}`, userId],
    );
    await pool.query('commit');
    return userId;
  } catch (error: unknown) {
    await pool.query('rollback');
    throw error;
  }
}

export function createControlLedgerCoordinatorTestEnvironment() {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const migrationBaseUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const maintenanceBaseUrl =
    process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
  const apiBaseUrl =
    process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
  const databaseName = `pertexo_test_ledger_coordinator_${randomUUID().replaceAll('-', '')}`;
  const withDatabase = (baseUrl: string) => {
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  const migrationUrl = withDatabase(migrationBaseUrl);
  const maintenanceUrl = withDatabase(maintenanceBaseUrl);
  const apiUrl = withDatabase(apiBaseUrl);
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
  const workspaceId = randomUUID();
  const failureWorkspaceId = randomUUID();
  const invalidWorkspaceId = randomUUID();
  const timeoutWorkspaceId = randomUUID();
  const cancellationWorkspaceId = randomUUID();
  const progressWorkspaceId = randomUUID();
  const backlogWorkspaceId = randomUUID();
  const deletionWorkspaceId = randomUUID();
  const committedArtifactIds = [randomUUID(), randomUUID()].toSorted();
  let priorDirectory = '';
  let maintenance: Pool | undefined;

  const initialize = async (): Promise<{
    deletionActorId: string;
    maintenance: Pool;
  }> => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(
        `create database "${databaseName}" owner pertexo_owner`,
      );
      await admin.query(`revoke all on database "${databaseName}" from public`);
      await admin.query(
        `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,
         pertexo_worker,pertexo_dispatcher,pertexo_maintenance`,
      );
    } finally {
      await admin.end();
    }

    priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'ledger-coordinator-prior-'),
    );
    for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
      if (/^\d{4}_.+\.sql$/u.test(name) && name < '0046_')
        await copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(priorDirectory, name),
        );
    }
    const priorApplied = await migrateDatabase(migrationConfig, priorDirectory);
    if (priorApplied.length !== 46) {
      throw new Error(
        `Expected 46 prior migrations, received ${String(priorApplied.length)}`,
      );
    }

    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    let deletionActorId = '';
    try {
      for (const id of [
        workspaceId,
        failureWorkspaceId,
        invalidWorkspaceId,
        timeoutWorkspaceId,
        cancellationWorkspaceId,
        progressWorkspaceId,
        backlogWorkspaceId,
      ]) {
        await createWorkspace(owner, id);
      }
      deletionActorId = await createWorkspace(owner, deletionWorkspaceId);
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      for (const artifactId of committedArtifactIds) {
        await owner.query(
          `insert into app.artifacts(
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values($1,$2,'test-fixture',$3,'text/plain',5,$4,'available',
                    clock_timestamp()+interval '1 day',clock_timestamp())`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          ],
        );
      }
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await owner.end();
    }

    for (const name of MIGRATIONS_AFTER_0045) {
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
    }
    const applied = await migrateDatabase(migrationConfig, priorDirectory);
    if (
      applied.length !== MIGRATIONS_AFTER_0045.length ||
      applied.some((name, index) => name !== MIGRATIONS_AFTER_0045[index])
    ) {
      throw new Error(
        `Unexpected forward migration cohort: ${JSON.stringify(applied)}`,
      );
    }
    maintenance = new Pool({ connectionString: maintenanceUrl, max: 4 });
    return { deletionActorId, maintenance };
  };

  const close = async (): Promise<void> => {
    await maintenance?.end();
    if (priorDirectory !== '')
      await rm(priorDirectory, { recursive: true, force: true });
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await dropDisconnectedDatabase(admin, databaseName);
    } finally {
      await admin.end();
    }
  };

  return {
    apiUrl,
    backlogWorkspaceId,
    cancellationWorkspaceId,
    close,
    committedArtifactIds,
    deletionWorkspaceId,
    failureWorkspaceId,
    initialize,
    invalidWorkspaceId,
    maintenanceUrl,
    migrationConfig,
    migrationUrl,
    progressWorkspaceId,
    timeoutWorkspaceId,
    workspaceId,
  };
}
