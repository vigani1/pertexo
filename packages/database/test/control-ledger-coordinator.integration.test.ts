import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTROL_LEDGER_ZERO_HASH,
  createControlLedgerCoordinator,
  type AppendControlLedgerRecord,
  type ControlLedger,
  type ControlLedgerRecord,
} from '../src/control-ledger-coordinator.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

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
let deletionActorId = '';
let priorDirectory = '';
let maintenance: Pool | undefined;

class MemoryLedger implements ControlLedger {
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

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,
       pertexo_worker,pertexo_dispatcher,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }

  priorDirectory = await mkdtemp(
    '/private/var/folders/1b/2tzp51hj4wg0rcvmj2j_pwlh0000gn/T/opencode/ledger-coordinator-prior-',
  );
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (/^\d{4}_.+\.sql$/u.test(name) && name < '0046_')
      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        path.join(priorDirectory, name),
      );
  }
  await expect(
    migrateDatabase(migrationConfig, priorDirectory),
  ).resolves.toHaveLength(46);
  const owner = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await createWorkspace(owner, workspaceId);
    await createWorkspace(owner, failureWorkspaceId);
    await createWorkspace(owner, invalidWorkspaceId);
    await createWorkspace(owner, timeoutWorkspaceId);
    await createWorkspace(owner, cancellationWorkspaceId);
    await createWorkspace(owner, progressWorkspaceId);
    await createWorkspace(owner, backlogWorkspaceId);
    deletionActorId = await createWorkspace(owner, deletionWorkspaceId);
  } finally {
    await owner.end();
  }
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0046_workspace_deletion_control_projection.sql',
    ),
    path.join(priorDirectory, '0046_workspace_deletion_control_projection.sql'),
  );
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0047_workspace_lifecycle_command_intents.sql',
    ),
    path.join(priorDirectory, '0047_workspace_lifecycle_command_intents.sql'),
  );
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0048_workspace_lifecycle_command_hardening.sql',
    ),
    path.join(priorDirectory, '0048_workspace_lifecycle_command_hardening.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0049_workspace_deletion_side_effects.sql'),
    path.join(priorDirectory, '0049_workspace_deletion_side_effects.sql'),
  );
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0050_workspace_lifecycle_api_authority.sql',
    ),
    path.join(priorDirectory, '0050_workspace_lifecycle_api_authority.sql'),
  );
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0051_workflow_run_input_retention_dry_run.sql',
    ),
    path.join(priorDirectory, '0051_workflow_run_input_retention_dry_run.sql'),
  );
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0052_workflow_run_input_retention_enforcement.sql',
    ),
    path.join(
      priorDirectory,
      '0052_workflow_run_input_retention_enforcement.sql',
    ),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0053_preview_retention_enforcement.sql'),
    path.join(priorDirectory, '0053_preview_retention_enforcement.sql'),
  );
  await copyFile(
    path.join(
      MIGRATIONS_DIRECTORY,
      '0054_workflow_run_input_retention_scheduling.sql',
    ),
    path.join(
      priorDirectory,
      '0054_workflow_run_input_retention_scheduling.sql',
    ),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0055_standard_retention_classes.sql'),
    path.join(priorDirectory, '0055_standard_retention_classes.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0056_workspace_purge_foundation.sql'),
    path.join(priorDirectory, '0056_workspace_purge_foundation.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0057_workspace_tenant_rows_purge.sql'),
    path.join(priorDirectory, '0057_workspace_tenant_rows_purge.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0058_workspace_object_versions_purge.sql'),
    path.join(priorDirectory, '0058_workspace_object_versions_purge.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0059_workspace_purge_completion.sql'),
    path.join(priorDirectory, '0059_workspace_purge_completion.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0060_standard_retention_dry_run.sql'),
    path.join(priorDirectory, '0060_standard_retention_dry_run.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0061_operator_outbox_redispatch.sql'),
    path.join(priorDirectory, '0061_operator_outbox_redispatch.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0062_operator_command_ledger.sql'),
    path.join(priorDirectory, '0062_operator_command_ledger.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0063_operator_execution_recovery.sql'),
    path.join(priorDirectory, '0063_operator_execution_recovery.sql'),
  );
  await copyFile(
    path.join(MIGRATIONS_DIRECTORY, '0064_operator_trigger_reconciliation.sql'),
    path.join(priorDirectory, '0064_operator_trigger_reconciliation.sql'),
  );
  await expect(
    migrateDatabase(migrationConfig, priorDirectory),
  ).resolves.toEqual([
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
  ]);
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 4 });
}, 120_000);

afterAll(async () => {
  await maintenance?.end();
  if (priorDirectory !== '')
    await rm(priorDirectory, { recursive: true, force: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('control ledger coordinator exact 0045 to 0047 integration', () => {
  it('proves the maintenance boundary and stable complete inventory', async () => {
    const coordinator = createControlLedgerCoordinator(
      {
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        ownerRole: migrationConfig.ownerRole,
        workerRuntimeRole: migrationConfig.workerRuntimeRole,
      },
      new MemoryLedger(),
      { inventoryPageSize: 3 },
    );
    try {
      await expect(
        coordinator.checkRestoreReadiness({
          expectedMaintenanceRole: migrationConfig.maintenanceRole,
        }),
      ).resolves.toBeUndefined();
      await expect(coordinator.reconcileAllWorkspaces()).resolves.toMatchObject(
        {
          projectedRecordCount: 0,
          sweepCount: 2,
          workspaceCount: 8,
        },
      );
    } finally {
      await coordinator.close();
    }
  });

  it('keeps maintenance least privileged and serializes the workspace lock', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    await expect(
      maintenance.query('select * from app.workspaces'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          "select app.validate_workspace_legal_hold_command($1,'legal_hold_placed',$2)",
          [workspaceId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
    await expect(
      maintenance.query(
        'select * from app.lock_workspace_control_ledger(null)',
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        "select app.validate_workspace_legal_hold_command(null,'legal_hold_placed',$1)",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        "select app.validate_workspace_legal_hold_command($1,'LEGAL_HOLD_PLACED',$2)",
        [workspaceId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query('select * from app.lock_workspace_control_ledger($1)', [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '23503' });

    const first = await maintenance.connect();
    const second = await maintenance.connect();
    try {
      await first.query('begin');
      await first.query('select * from app.lock_workspace_control_ledger($1)', [
        workspaceId,
      ]);
      await second.query('begin');
      let acquired = false;
      const waiting = second
        .query('select * from app.lock_workspace_control_ledger($1)', [
          workspaceId,
        ])
        .then(() => {
          acquired = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      await first.query('commit');
      await waiting;
      expect(acquired).toBe(true);
      await second.query('commit');
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('leaves PostgreSQL unchanged when append fails', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    ledger.failAppend = true;
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
    );
    await expect(
      coordinator.placeLegalHold({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        holdId: randomUUID(),
        legalAuthority: 'case-append-failure',
        occurredAt: '2026-08-26T12:00:00.000Z',
        reason: 'append failure proof',
        workspaceId: failureWorkspaceId,
      }),
    ).rejects.toThrow('ledger unavailable');
    const highWater = await maintenance.query(
      'select * from app.lock_workspace_control_ledger($1)',
      [failureWorkspaceId],
    );
    expect(highWater.rows[0]).toMatchObject({
      retention_control_hash: CONTROL_LEDGER_ZERO_HASH,
      retention_control_sequence: '0',
    });
    await coordinator.close();
  });

  it('rejects invalid transitions before creating external records', async () => {
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
    );
    const base = {
      actorRef: 'operator:test',
      commandId: randomUUID(),
      holdId: randomUUID(),
      legalAuthority: 'case-invalid-transitions',
      occurredAt: '2026-08-26T12:00:00.000Z',
      reason: 'transition preflight proof',
      workspaceId: invalidWorkspaceId,
    };
    await expect(coordinator.releaseLegalHold(base)).rejects.toMatchObject({
      code: '55000',
    });
    expect(ledger.records.get(invalidWorkspaceId) ?? []).toHaveLength(0);

    await coordinator.placeLegalHold({ ...base, commandId: randomUUID() });
    await expect(
      coordinator.placeLegalHold({ ...base, commandId: randomUUID() }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(ledger.records.get(invalidWorkspaceId) ?? []).toHaveLength(1);

    await coordinator.releaseLegalHold({ ...base, commandId: randomUUID() });
    await expect(
      coordinator.releaseLegalHold({ ...base, commandId: randomUUID() }),
    ).rejects.toMatchObject({ code: '55000' });
    expect(ledger.records.get(invalidWorkspaceId) ?? []).toHaveLength(2);
    await coordinator.close();
  });

  it('keeps the row lock until external timeout rollback', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    ledger.hangReconcile = true;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    ledger.reconcileStarted = notifyStarted;
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { externalOperationTimeoutMs: 1_000 },
    );
    const reconciling = coordinator.reconcileWorkspace({
      workspaceId: timeoutWorkspaceId,
    });
    await started;
    const waiter = await maintenance.connect();
    try {
      await waiter.query('begin');
      let acquired = false;
      const waiting = waiter
        .query('select * from app.lock_workspace_control_ledger($1)', [
          timeoutWorkspaceId,
        ])
        .then(() => {
          acquired = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      await expect(reconciling).rejects.toMatchObject({ name: 'TimeoutError' });
      await waiting;
      expect(acquired).toBe(true);
      await waiter.query('commit');
    } finally {
      await waiter.query('rollback').catch(() => undefined);
      waiter.release();
      await coordinator.close();
    }
  });

  it('cancels an in-flight workspace lock query with the caller reason', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const blocker = await maintenance.connect();
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
    );
    try {
      await blocker.query('begin');
      await blocker.query(
        'select * from app.lock_workspace_control_ledger($1)',
        [cancellationWorkspaceId],
      );
      const controller = new AbortController();
      const reason = new Error('operator cancelled lock wait');
      const pending = coordinator.reconcileWorkspace({
        signal: controller.signal,
        workspaceId: cancellationWorkspaceId,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await coordinator.close();
    }
  });

  it('durably commits bounded chunks and appends after backlog catch-up', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    const seed = async (targetWorkspaceId: string, count: number) => {
      let previousHash = CONTROL_LEDGER_ZERO_HASH;
      for (let sequence = 1; sequence <= count; sequence += 1) {
        const appended = await ledger.append({
          actorRef: 'operator:seed',
          commandId: randomUUID(),
          commandType: 'legal_hold_placed',
          legalAuthority: 'case-backlog',
          occurredAt: `2026-08-26T12:0${String(sequence)}:00.000Z`,
          previousHash,
          reason: 'backlog reconciliation proof',
          sequence,
          subjectId: randomUUID(),
          workspaceId: targetWorkspaceId,
        });
        previousHash = appended.recordHash;
      }
    };
    await seed(progressWorkspaceId, 2);
    const bounded = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { maxPages: 1, maxRecords: 1, pageSize: 1 },
    );
    await expect(
      bounded.reconcileWorkspace({ workspaceId: progressWorkspaceId }),
    ).rejects.toThrow('invocation bound exceeded');
    const progressed = await maintenance.query<{
      retention_control_sequence: string;
    }>('select * from app.lock_workspace_control_ledger($1)', [
      progressWorkspaceId,
    ]);
    expect(progressed.rows[0]?.retention_control_sequence).toBe('1');
    await expect(
      bounded.reconcileWorkspace({ workspaceId: progressWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 2, projectedCount: 1 });
    await bounded.close();

    await seed(backlogWorkspaceId, 2);
    const command = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { maxPages: 2, maxRecords: 2, pageSize: 1 },
    );
    await expect(
      command.placeLegalHold({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        holdId: randomUUID(),
        legalAuthority: 'case-command-backlog',
        occurredAt: '2026-08-26T12:03:00.000Z',
        reason: 'append only after catch-up',
        workspaceId: backlogWorkspaceId,
      }),
    ).resolves.toMatchObject({ sequence: 3 });
    expect(ledger.records.get(backlogWorkspaceId) ?? []).toHaveLength(3);
    await command.close();
  });

  it('recovers the append crash window and projects place/release/multiple holds exactly', async () => {
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
      { pageSize: 1 },
    );
    const firstCommand = randomUUID();
    const firstHold = randomUUID();
    const controller = new AbortController();
    ledger.abortAfterAppend = controller;
    const firstInput = {
      actorRef: 'operator:test',
      commandId: firstCommand,
      holdId: firstHold,
      legalAuthority: 'case-one',
      occurredAt: '2026-08-26T12:01:00.000Z',
      reason: 'first hold',
      workspaceId,
    };
    await expect(
      coordinator.placeLegalHold({ ...firstInput, signal: controller.signal }),
    ).rejects.toThrow('simulated process interruption');
    await expect(coordinator.placeLegalHold(firstInput)).resolves.toMatchObject(
      {
        replayed: true,
        sequence: 1,
      },
    );
    const secondHold = randomUUID();
    await expect(
      coordinator.placeLegalHold({
        ...firstInput,
        commandId: randomUUID(),
        holdId: secondHold,
        occurredAt: '2026-08-26T12:02:00.000Z',
        reason: 'second hold',
      }),
    ).resolves.toMatchObject({ sequence: 2 });
    const releaseCommand = randomUUID();
    await expect(
      coordinator.releaseLegalHold({
        ...firstInput,
        commandId: releaseCommand,
        legalAuthority: 'case-one-release',
        occurredAt: '2026-08-26T12:03:00.000Z',
        reason: 'release first hold',
      }),
    ).resolves.toMatchObject({ sequence: 3 });

    const verifier = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await verifier.query('begin');
      await verifier.query('set local role pertexo_owner');
      const rows = await verifier.query(
        `select retention_control_sequence,retention_control_hash,
          (select count(*) from app.workspace_legal_holds where workspace_id=$1) hold_count,
          (select count(*) from app.workspace_legal_holds where workspace_id=$1 and released_sequence is null) active_count
         from app.workspaces where id=$1`,
        [workspaceId],
      );
      expect(rows.rows[0]).toMatchObject({
        active_count: '1',
        hold_count: '2',
        retention_control_hash: '3'.padStart(64, '0'),
        retention_control_sequence: '3',
      });
      await verifier.query('commit');
    } finally {
      await verifier.end();
    }
    await coordinator.close();
  });

  it('projects request, restore, purge start, and completion from event time without deletion SQL', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    const ledger = new MemoryLedger();
    const coordinator = createControlLedgerCoordinator(
      {
        ...migrationConfig,
        connectionString: maintenanceUrl,
        connectionTimeoutMillis: 1_000,
        idleTimeoutMillis: 1_000,
        max: 2,
      },
      ledger,
    );
    const seeded: ControlLedgerRecord[] = [];
    ledger.records.set(deletionWorkspaceId, seeded);
    const seedDeletion = (
      commandType:
        | 'deletion_requested'
        | 'deletion_restored'
        | 'purge_started'
        | 'deletion_completed',
      occurredAt: string,
      reason: string,
    ): ControlLedgerRecord => {
      const previous = seeded.at(-1);
      const sequence = (previous?.sequence ?? 0) + 1;
      const record: ControlLedgerRecord = {
        actorRef: deletionActorId,
        commandId: randomUUID(),
        commandType,
        occurredAt,
        previousHash: previous?.recordHash ?? CONTROL_LEDGER_ZERO_HASH,
        reason,
        recordHash: sequence.toString(16).padStart(64, '0'),
        schemaVersion: 1,
        sequence,
        subjectId: deletionWorkspaceId,
        workspaceId: deletionWorkspaceId,
      };
      seeded.push(record);
      return record;
    };
    const requested = seedDeletion(
      'deletion_requested',
      '2026-01-01T00:00:00.000Z',
      'Deletion lifecycle integration proof',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 1, projectedCount: 1 });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,2,$2,'deletion_restored',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          requested.recordHash,
          'e'.repeat(64),
          deletionActorId,
          'Restore cannot predate request',
          '2025-12-31T23:59:59.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    seedDeletion(
      'deletion_restored',
      '2026-01-02T00:00:00.000Z',
      'Restore before deadline',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 2, projectedCount: 1 });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,3,$2,'deletion_requested',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          '2'.padStart(64, '0'),
          'e'.repeat(64),
          deletionActorId,
          'New request cannot predate restore',
          '2026-01-01T12:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    seedDeletion(
      'deletion_requested',
      '2026-01-03T00:00:00.000Z',
      'Second deletion lifecycle request',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 3, projectedCount: 1 });
    seedDeletion(
      'purge_started',
      '2026-02-02T00:00:00.000Z',
      'Authoritative purge workflow started',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).resolves.toMatchObject({ highWaterSequence: 4, projectedCount: 1 });
    const holdId = randomUUID();
    await coordinator.placeLegalHold({
      actorRef: 'operator:retention',
      commandId: randomUUID(),
      holdId,
      legalAuthority: 'case-deletion-completion-block',
      occurredAt: '2026-02-02T01:00:00.000Z',
      reason: 'Hold before deletion completion',
      workspaceId: deletionWorkspaceId,
    });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,6,$2,'deletion_completed',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          '5'.padStart(64, '0'),
          'f'.repeat(64),
          deletionActorId,
          'Completion must fail under hold',
          '2026-02-03T00:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await coordinator.releaseLegalHold({
      actorRef: 'operator:retention',
      commandId: randomUUID(),
      holdId,
      legalAuthority: 'case-deletion-completion-release',
      occurredAt: '2026-02-02T02:00:00.000Z',
      reason: 'Release hold for deletion completion',
      workspaceId: deletionWorkspaceId,
    });
    await expect(
      maintenance.query(
        `select app.project_workspace_deletion(
          $1,7,$2,'deletion_completed',$1,$3,$4,$5,null,$6,$7
        )`,
        [
          deletionWorkspaceId,
          randomUUID(),
          '6'.padStart(64, '0'),
          'e'.repeat(64),
          deletionActorId,
          'Completion cannot predate purge start',
          '2026-02-01T00:00:00.000Z',
        ],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    seedDeletion(
      'deletion_completed',
      '2026-02-03T00:00:00.000Z',
      'Authoritative purge workflow completed',
    );
    await expect(
      coordinator.reconcileWorkspace({ workspaceId: deletionWorkspaceId }),
    ).rejects.toMatchObject({ code: '55000' });

    const verifier = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await verifier.query('begin');
      await verifier.query('set local role pertexo_owner');
      const state = await verifier.query<{
        deletion_requested_at: Date | string;
        fact_count: string;
        purge_after: Date | string;
        retention_control_sequence: string;
        status: string;
      }>(
        `select status,deletion_requested_at,purge_after,retention_control_sequence,
          (select count(*) from app.retention_control_audit_facts where workspace_id=$1) fact_count
         from app.workspaces where id=$1`,
        [deletionWorkspaceId],
      );
      expect(state.rows[0]).toMatchObject({
        fact_count: '6',
        retention_control_sequence: '6',
        status: 'purging',
      });
      const row = state.rows[0];
      if (row === undefined)
        throw new Error('Missing deletion workspace state');
      expect(new Date(row.deletion_requested_at).toISOString()).toBe(
        '2026-01-03T00:00:00.000Z',
      );
      expect(new Date(row.purge_after).toISOString()).toBe(
        '2026-02-02T00:00:00.000Z',
      );
      await verifier.query('commit');
    } finally {
      await verifier.query('rollback').catch(() => undefined);
      await verifier.end();
      await coordinator.close();
    }
  });

  it('keeps anchor enumeration maintenance-only and denies legacy API lifecycle writes', async () => {
    if (maintenance === undefined)
      throw new Error('Maintenance pool unavailable');
    await expect(
      maintenance.query(
        'select * from app.enumerate_workspace_control_anchors(null,101)',
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      maintenance.query(
        'select * from app.enumerate_workspace_control_anchors(null,2)',
      ),
    ).resolves.toMatchObject({ rowCount: 2 });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          'select * from app.enumerate_workspace_control_anchors(null,1)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query("update app.workspaces set status='suspended' where id=$1", [
          workspaceId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          `update app.workspaces set status='pending_deletion',
             deletion_requested_at='2026-08-26T00:00:00Z',
             deletion_requested_by=$2,deletion_reason='legacy API proof',
             purge_after='2026-09-25T00:00:00Z'
           where id=$1`,
          [workspaceId, deletionActorId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          `update app.workspaces set status='suspended',deletion_requested_at=null,
             deletion_requested_by=null,deletion_reason=null,purge_after=null
           where id=$1`,
          [workspaceId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await expect(
        owner.query(
          `update app.workspaces set retention_control_sequence=retention_control_sequence+1
           where id=$1`,
          [workspaceId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
  });
});
