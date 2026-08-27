import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  createConnectionDatabase,
  type ConnectionDatabase,
  type CreateConnectionInput,
} from '../src/connections.js';
import {
  createFailureNotificationDestinationDatabase,
  FailureNotificationDestinationIdempotencyConflictError,
  FailureNotificationDestinationNotFoundError,
  type FailureNotificationDestinationDatabase,
} from '../src/failure-notification-destinations.js';
import { createFailureNotificationStore } from '../src/failure-notifications.js';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { canonicalOutboxPayloadChecksum } from '../src/outbox.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import { checkDatabaseReadiness } from '../src/readiness.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_connections_${randomUUID().replaceAll('-', '')}`;
const upgradeDatabaseName = `pertexo_test_connections_upgrade_${randomUUID().replaceAll('-', '')}`;
const priorDatabaseName = `pertexo_test_connections_prior_${randomUUID().replaceAll('-', '')}`;
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const historicalWorkspaceId = randomUUID();
const historicalOwnerId = randomUUID();
const historicalRunId = randomUUID();
const historicalIntentId = randomUUID();
const historicalRetryIntentId = randomUUID();
const historicalDispatchingIntentId = randomUUID();
const historicalDestinationId = randomUUID();
const historicalOutboxByIntent = new Map(
  [
    historicalIntentId,
    historicalRetryIntentId,
    historicalDispatchingIntentId,
  ].map((intentId) => [intentId, randomUUID()]),
);

let api: ConnectionDatabase;
let worker: ConnectionDatabase;
let destinations: FailureNotificationDestinationDatabase;
let closeResources = (): Promise<void> => Promise.resolve();
let upgradeApplied: readonly string[] = [];
let priorApplied: readonly string[] = [];

function databaseUrl(base: string, name = databaseName): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function pgCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === expected) return true;
      current = current.cause;
    }
    return false;
  };
}

async function createDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, name);
  } finally {
    await admin.end();
  }
}

function migrationConfig(name = databaseName) {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, name),
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;
}

async function migrateBefore(name: string, boundary: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-prior-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < boundary,
    );
    await Promise.all(
      migrations.map((migration) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, migration),
          path.join(directory, migration),
        ),
      ),
    );
    await migrateDatabase(migrationConfig(name), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function seedWorkspaces(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    for (const [workspaceId, ownerId, suffix] of [
      [workspaceA, ownerA, 'a'],
      [workspaceB, ownerB, 'b'],
    ] as const) {
      await client.query(
        `insert into app.users (id, email, display_name, status)
         values ($1, $2, $3, 'active')`,
        [ownerId, `connection-${suffix}@example.test`, `Owner ${suffix}`],
      );
      await client.query(
        `insert into app.workspaces
           (id, name, slug, status, created_by)
         values ($1, $2, $3, 'active', $4)`,
        [workspaceId, `Workspace ${suffix}`, `connection-${suffix}`, ownerId],
      );
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships
           (workspace_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [workspaceId, ownerId],
      );
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function seedPriorNotificationRows(): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl, priorDatabaseName),
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(
      'alter table app.workflow_runs no force row level security',
    );
    await client.query(
      'alter table app.run_failure_notification_intents no force row level security',
    );
    await client.query(
      `insert into app.users (id,email,display_name,status)
       values ($1,$2,'Historical notification owner','active')`,
      [historicalOwnerId, `historical-${historicalOwnerId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id,name,slug,status,created_by)
       values ($1,'Historical notifications',$2,'active',$3)`,
      [
        historicalWorkspaceId,
        `historical-${historicalWorkspaceId.slice(0, 8)}`,
        historicalOwnerId,
      ],
    );
    await client.query("select set_config('app.workspace_id',$1,true)", [
      historicalWorkspaceId,
    ]);
    await client.query(
      `insert into app.workflow_runs (
         id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         failure_notification_policy_version,failure_notification_destination_id,
         failure_notification_destination_config_version,
         failure_notification_side_effect_class
       ) values ($1,$2,$3,$4,'manual','failed',1,$5,7,'safe')`,
      [
        historicalRunId,
        historicalWorkspaceId,
        randomUUID(),
        randomUUID(),
        historicalDestinationId,
      ],
    );
    for (const [intentId, sequence, status] of [
      [historicalIntentId, 1, 'pending'],
      [historicalRetryIntentId, 2, 'retry'],
      [historicalDispatchingIntentId, 3, 'dispatching'],
    ] as const) {
      await client.query(
        `insert into app.run_failure_notification_intents (
           id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
           destination_id,destination_config_version,side_effect_class,context,
           context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at,
           next_delivery_at
         ) values ($1,$2,$3,$4,1,$5,7,'safe','{}'::jsonb,$6,$7::varchar,
           case when $7::text='pending' then 0 else 1 end,
           case when $7::text='dispatching' then clock_timestamp() end,
           case when $7::text='dispatching' then clock_timestamp()+interval '1 minute' end,
           case when $7::text='retry' then clock_timestamp() end)`,
        [
          intentId,
          historicalWorkspaceId,
          historicalRunId,
          sequence,
          historicalDestinationId,
          'a'.repeat(64),
          status,
        ],
      );
      const outboxEventId = historicalOutboxByIntent.get(intentId);
      if (outboxEventId === undefined)
        throw new Error('Historical outbox fixture is incomplete');
      const payload = {
        schemaVersion: 1 as const,
        workspaceId: historicalWorkspaceId,
        notificationIntentId: intentId,
        outboxEventId,
      };
      await client.query(
        `insert into app.outbox_events (
           id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
           payload,payload_checksum
         ) values ($1,$2,'deliver-run-failure-notification',1,
           'run-failure-notification',$3,$4::jsonb,$5)`,
        [
          outboxEventId,
          historicalWorkspaceId,
          intentId,
          JSON.stringify(payload),
          canonicalOutboxPayloadChecksum(payload),
        ],
      );
    }
    await client.query(
      'alter table app.workflow_runs force row level security',
    );
    await client.query(
      'alter table app.run_failure_notification_intents force row level security',
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const sealed = (marker: number) => ({
  schemaVersion: 1 as const,
  kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
  encryptedDataKey: Buffer.alloc(96, marker).toString('base64url'),
  ciphertext: Buffer.from(`encrypted-${String(marker)}`).toString('base64url'),
  nonce: Buffer.alloc(12, marker).toString('base64url'),
  tag: Buffer.alloc(16, marker).toString('base64url'),
});

function createInput(
  overrides: Partial<CreateConnectionInput> = {},
): CreateConnectionInput {
  const connectionId = overrides.connectionId ?? randomUUID();
  const secretVersionId = overrides.secretVersionId ?? randomUUID();
  const name = overrides.name ?? `HTTP ${connectionId.slice(0, 8)}`;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ name, connectionId }))
    .digest('hex');
  return {
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId,
    secretVersionId,
    providerKey: 'http',
    name,
    authType: CONNECTION_AUTH_TYPE.httpHeaders,
    sealed: sealed(1),
    idempotencyKey: `create-${connectionId}`,
    requestHash,
    requestId: `request-${connectionId}`,
    traceId: `trace-${connectionId}`,
    ...overrides,
  };
}

beforeAll(async () => {
  await Promise.all([
    createDatabase(databaseName),
    createDatabase(upgradeDatabaseName),
    createDatabase(priorDatabaseName),
  ]);
  await migrateDatabase(migrationConfig());
  await migrateBefore(upgradeDatabaseName, '0021_');
  upgradeApplied = await migrateDatabase(migrationConfig(upgradeDatabaseName));
  await migrateBefore(priorDatabaseName, '0037_');
  await seedPriorNotificationRows();
  priorApplied = await migrateDatabase(migrationConfig(priorDatabaseName));
  await seedWorkspaces();
  api = createConnectionDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 4 }),
  );
  worker = createConnectionDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerBaseUrl),
      max: 4,
    }),
  );
  destinations = createFailureNotificationDestinationDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 4 }),
  );
  closeResources = async (): Promise<void> => {
    await Promise.allSettled([
      api.close(),
      worker.close(),
      destinations.close(),
    ]);
  };
});

afterAll(async () => {
  await closeResources();
  await Promise.all([
    dropDatabase(databaseName),
    dropDatabase(upgradeDatabaseName),
    dropDatabase(priorDatabaseName),
  ]);
});

describe('connection persistence', () => {
  it('idempotently manages immutable failure-notification destinations and workflow policy', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Email ${randomUUID()}`,
    });
    await api.createConnection(connection);
    const workflowId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const ownerClient = await owner.connect();
    try {
      await ownerClient.query('begin');
      await ownerClient.query('set local role pertexo_owner');
      await ownerClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await ownerClient.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,'Notification policy',$3)`,
        [workflowId, workspaceA, ownerA],
      );
      await ownerClient.query('commit');
    } finally {
      await ownerClient.query('rollback').catch(() => undefined);
      ownerClient.release();
      await owner.end();
    }

    const destinationId = randomUUID();
    const create = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: {
        kind: 'email' as const,
        connectionId: connection.connectionId,
        toEmail: 'Ops@EXAMPLE.TEST',
      },
      idempotencyKey: `destination-create-${destinationId}`,
      requestHash: '1'.repeat(64),
      requestId: `request-${destinationId}`,
    };
    const created = await destinations.create(create);
    expect(created.config).toMatchObject({ toEmail: 'Ops@example.test' });
    const replayed = await destinations.create({
      ...create,
      destinationId: randomUUID(),
    });
    expect(replayed).toEqual(created);
    await expect(
      destinations.create({ ...create, requestHash: '2'.repeat(64) }),
    ).rejects.toBeInstanceOf(
      FailureNotificationDestinationIdempotencyConflictError,
    );

    const append = {
      ...create,
      destinationId,
      expectedVersion: 1,
      config: { ...create.config, toEmail: 'alerts@example.test' },
      idempotencyKey: `destination-append-${destinationId}`,
      requestHash: '3'.repeat(64),
    };
    const appended = await destinations.appendVersion(append);
    await expect(destinations.appendVersion(append)).resolves.toEqual(appended);
    expect(appended).toMatchObject({
      currentVersion: 2,
      config: { toEmail: 'alerts@example.test' },
    });

    const setPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      destinationId,
      idempotencyKey: `policy-set-${workflowId}`,
      requestHash: '4'.repeat(64),
    };
    await destinations.setWorkflowPolicy(setPolicy);
    await destinations.setWorkflowPolicy(setPolicy);
    const status = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      status: 'disabled' as const,
      idempotencyKey: `destination-status-${destinationId}`,
      requestHash: '5'.repeat(64),
    };
    await destinations.setStatus(status);
    await expect(destinations.setStatus(status)).resolves.toMatchObject({
      status: 'disabled',
    });
    await expect(
      destinations.list({ workspaceId: workspaceB, actorId: ownerB }),
    ).resolves.toEqual([]);
    const clearPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      idempotencyKey: `policy-clear-${workflowId}`,
      requestHash: '6'.repeat(64),
    };
    await destinations.clearWorkflowPolicy(clearPolicy);
    await destinations.clearWorkflowPolicy(clearPolicy);
    const deletion = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    const deletionClient = await deletion.connect();
    await deletionClient.query('begin');
    await deletionClient.query('set local role pertexo_owner');
    await deletionClient.query(
      "select set_config('app.workspace_id',$1,true)",
      [workspaceA],
    );
    await deletionClient.query('delete from app.workflows where id=$1', [
      workflowId,
    ]);
    await deletionClient.query('commit');
    deletionClient.release();
    await deletion.end();
    await expect(
      destinations.clearWorkflowPolicy(clearPolicy),
    ).resolves.toBeUndefined();
    await expect(
      destinations.clearWorkflowPolicy({
        ...clearPolicy,
        idempotencyKey: `${clearPolicy.idempotencyKey}-new`,
      }),
    ).rejects.toBeInstanceOf(FailureNotificationDestinationNotFoundError);

    const audit = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const auditClient = await audit.connect();
    try {
      await auditClient.query('begin');
      await auditClient.query('set local role pertexo_owner');
      await auditClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      const result = await auditClient.query<{ count: string }>(
        `select count(*)::text from app.audit_events
          where target_id in ($1,$2)
            and action in (
              'failure_notification_destination.created',
              'failure_notification_destination.version_appended',
              'failure_notification_destination.disabled',
              'workflow.failure_notification_policy_set',
              'workflow.failure_notification_policy_cleared'
            )`,
        [destinationId, workflowId],
      );
      expect(result.rows[0]?.count).toBe('5');
    } finally {
      await auditClient.query('rollback').catch(() => undefined);
      auditClient.release();
      await audit.end();
    }
  });

  it('upgrades populated exact 0036 notification rows without fabricating destination config', async () => {
    expect(priorApplied).toEqual([
      '0037_failure_notification_destinations.sql',
      '0038_execution_admission.sql',
      '0039_webhook_triggers.sql',
      '0040_schedule_triggers.sql',
      '0041_trigger_hardening.sql',
      '0042_worker_run_admission_lock.sql',
      '0043_workflow_run_input_retention.sql',
      '0044_retention_control_foundation.sql',
      '0045_control_ledger_command_lock.sql',
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
    ]);
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, priorDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0066_operator_maintenance_rerun.sql',
      });
      const bindingSurface = await pool.query<{
        node_column: boolean;
        node_constraint: boolean;
        node_worker_update: boolean;
        preview_column: boolean;
        preview_constraint: boolean;
        preview_worker_update: boolean;
      }>(
        `select
           exists (
             select 1 from information_schema.columns
             where table_schema='app' and table_name='node_runs'
               and column_name='provider_dispatch_binding'
               and data_type='character varying' and character_maximum_length=128
           ) node_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.node_runs'::regclass
               and conname='node_runs_provider_dispatch_binding_format'
           ) node_constraint,
           has_column_privilege(
             'pertexo_worker','app.node_runs','provider_dispatch_binding','UPDATE'
           ) node_worker_update,
           exists (
             select 1 from information_schema.columns
             where table_schema='app' and table_name='preview_attempts'
               and column_name='provider_dispatch_binding'
               and data_type='character varying' and character_maximum_length=128
           ) preview_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.preview_attempts'::regclass
               and conname='preview_attempts_provider_dispatch_binding_format'
           ) preview_constraint,
           has_column_privilege(
             'pertexo_worker','app.preview_attempts','provider_dispatch_binding','UPDATE'
           ) preview_worker_update`,
      );
      expect(bindingSurface.rows[0]).toEqual({
        node_column: true,
        node_constraint: true,
        node_worker_update: true,
        preview_column: true,
        preview_constraint: true,
        preview_worker_update: true,
      });
      const historicalPool = new Pool({
        connectionString: databaseUrl(migrationBaseUrl, priorDatabaseName),
        max: 1,
      });
      const historicalClient = await historicalPool.connect();
      try {
        await historicalClient.query('begin');
        await historicalClient.query('set local role pertexo_owner');
        await historicalClient.query(
          'alter table app.run_failure_notification_intents no force row level security',
        );
        await historicalClient.query(
          'alter table app.run_failure_notification_audit_facts no force row level security',
        );
        await historicalClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [historicalWorkspaceId],
        );
        const historical = await historicalClient.query<{
          audit_count: string;
          completed_count: string;
          intent_secret: string | null;
          run_secret: string | null;
          dead_letter_count: string;
          ambiguous_count: string;
          unvalidated_fks: string;
        }>(
          `select
             (select connection_secret_version_id::text
                from app.run_failure_notification_intents where id=$1) intent_secret,
              (select failure_notification_connection_secret_version_id::text
                 from app.workflow_runs where id=$2) run_secret,
               (select count(*)::text from app.run_failure_notification_intents
                 where id=any($3::uuid[]) and status='dead_letter'
                   and safe_error_code='delivery.destination_unavailable'
                   and possibly_dispatched=false
                   and completed_at is not null and recovery_at is null
                   and next_delivery_at is null and dispatch_marked_at is null) dead_letter_count,
               (select count(*)::text from app.run_failure_notification_intents
                 where id=$4 and status='outcome_unknown'
                   and safe_error_code='delivery.recovery_ambiguous'
                   and possibly_dispatched=true and completed_at is not null
                   and recovery_at is null and next_delivery_at is null
                   and dispatch_marked_at is null) ambiguous_count,
              (select count(*)::text from app.run_failure_notification_intents
                where id=any($3::uuid[]) and completed_at is not null) completed_count,
              (select count(*)::text from app.run_failure_notification_audit_facts
                where notification_intent_id=any($3::uuid[])
                   and ((notification_intent_id=$4 and fact_type='outcome_unknown'
                         and safe_error_code='delivery.recovery_ambiguous'
                         and possibly_dispatched=true)
                     or (notification_intent_id<>$4 and fact_type='dead_lettered'
                         and safe_error_code='delivery.destination_unavailable'
                         and possibly_dispatched=false))) audit_count,
              (select count(*)::text from pg_constraint
               where conname in (
                 'workflow_runs_failure_notification_destination_version_fk',
                 'run_failure_notification_intents_destination_version_fk'
               ) and not convalidated) unvalidated_fks`,
          [
            historicalIntentId,
            historicalRunId,
            [
              historicalIntentId,
              historicalRetryIntentId,
              historicalDispatchingIntentId,
            ],
            historicalDispatchingIntentId,
          ],
        );
        expect(historical.rows[0]).toEqual({
          audit_count: '3',
          ambiguous_count: '1',
          completed_count: '3',
          dead_letter_count: '2',
          intent_secret: null,
          run_secret: null,
          unvalidated_fks: '2',
        });
        await expect(
          historicalClient.query(
            `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,context,
               context_checksum
             ) values ($1,$2,$3,2,1,$4,8,'safe','{}'::jsonb,$5)`,
            [
              randomUUID(),
              historicalWorkspaceId,
              historicalRunId,
              historicalDestinationId,
              'b'.repeat(64),
            ],
          ),
        ).rejects.toSatisfy(pgCode('23503'));
      } finally {
        await historicalClient.query('rollback').catch(() => undefined);
        historicalClient.release();
        await historicalPool.end();
      }
      const historicalStore = createFailureNotificationStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerBaseUrl, priorDatabaseName),
          max: 1,
        }),
      );
      try {
        for (const [intentId, outboxEventId] of historicalOutboxByIntent) {
          const payload = {
            schemaVersion: 1 as const,
            workspaceId: historicalWorkspaceId,
            notificationIntentId: intentId,
            outboxEventId,
          };
          await expect(
            historicalStore.claimDelivery({
              workspaceId: historicalWorkspaceId,
              intentId,
              delivery: {
                outboxEventId,
                payloadChecksum: canonicalOutboxPayloadChecksum(payload),
              },
              recoverySeconds: 1,
              maxAttempts: 3,
            }),
          ).resolves.toEqual({ kind: 'terminal' });
        }
      } finally {
        await historicalStore.close();
      }
    } finally {
      await pool.end();
    }
  });

  it('upgrades the supported pre-phase-4 head through all later migrations', async () => {
    expect(upgradeApplied).toEqual([
      '0021_workflow_integration_usage.sql',
      '0022_preview_execution.sql',
      '0023_preview_artifact_ownership.sql',
      '0024_preview_retention_cleanup.sql',
      '0025_preview_cleanup_idempotency.sql',
      '0026_preview_cleanup_terminal_guard.sql',
      '0027_preview_terminal_facts.sql',
      '0028_preview_terminal_fact_corrections.sql',
      '0029_provider_idempotency_key_invariants.sql',
      '0030_coordinator_retry_decisions.sql',
      '0031_due_node_wakeups.sql',
      '0032_for_each_barriers.sql',
      '0033_durable_wait.sql',
      '0034_run_failure_notifications.sql',
      '0035_slack_bot_token_connections.sql',
      '0036_resend_api_key_connections.sql',
      '0037_failure_notification_destinations.sql',
      '0038_execution_admission.sql',
      '0039_webhook_triggers.sql',
      '0040_schedule_triggers.sql',
      '0041_trigger_hardening.sql',
      '0042_worker_run_admission_lock.sql',
      '0043_workflow_run_input_retention.sql',
      '0044_retention_control_foundation.sql',
      '0045_control_ledger_command_lock.sql',
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
    ]);
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0066_operator_maintenance_rerun.sql',
      });
    } finally {
      await pool.end();
    }
  });

  it('atomically creates one current immutable secret and replays an exact request', async () => {
    const input = createInput();
    const created = await api.createConnection(input);
    const replayed = await api.createConnection({
      ...input,
      connectionId: randomUUID(),
      secretVersionId: randomUUID(),
      sealed: sealed(2),
    });

    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      id: input.connectionId,
      workspaceId: workspaceA,
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
      currentSecretVersionId: input.secretVersionId,
    });
    expect(JSON.stringify(created)).not.toContain('encrypted');

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{
        connection_count: string;
        event_count: string;
        secret_count: string;
        plaintext_columns: string;
      }>(
        `select
           (select count(*)::text from app.connections where id = $1) as connection_count,
           (select count(*)::text from app.connection_secret_versions where connection_id = $1) as secret_count,
           (select count(*)::text from app.connection_events where connection_id = $1) as event_count,
           (select count(*)::text from information_schema.columns
             where table_schema = 'app'
               and table_name = 'connection_secret_versions'
               and column_name ~ '(plaintext|credential|secret_value)') as plaintext_columns`,
        [input.connectionId],
      );
      expect(result.rows[0]).toEqual({
        connection_count: '1',
        event_count: '1',
        secret_count: '1',
        plaintext_columns: '0',
      });
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('creates, resolves, fences, rotates, audits, and revokes a Slack bot token connection', async () => {
    const input = createInput({
      providerKey: 'slack',
      authType: CONNECTION_AUTH_TYPE.slackBotToken,
      name: `Slack ${randomUUID().slice(0, 8)}`,
    });
    const created = await api.createConnection(input);
    expect(created).toMatchObject({
      providerKey: 'slack',
      authType: 'slack_bot_token',
      status: 'active',
    });

    const resolved = await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'slack',
      workerId: 'slack-worker',
      purpose: 'slack.send_message.execute',
    });
    expect(resolved).toMatchObject({ secretVersionId: input.secretVersionId });
    await worker.assertConnectionSecretCurrent({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'slack',
      expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
      secretVersionId: input.secretVersionId,
    });

    const nextVersion = randomUUID();
    const rotated = await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
      expectedCurrentSecretVersionId: input.secretVersionId,
      expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
      secretVersionId: nextVersion,
      sealed: sealed(9),
      idempotencyKey: `rotate-slack-${created.id}`,
      requestHash: createHash('sha256')
        .update(`rotate:${created.id}`)
        .digest('hex'),
    });
    expect(rotated.currentSecretVersionId).toBe(nextVersion);
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'slack',
        expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'slack',
        workerId: 'slack-worker',
        purpose: 'slack.send_message.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const ownerClient = await owner.connect();
    await ownerClient.query('begin');
    await ownerClient.query('set local role pertexo_owner');
    await ownerClient.query("select set_config('app.workspace_id', $1, true)", [
      workspaceA,
    ]);
    const audit = await ownerClient.query<{ event_type: string }>(
      `select event_type from app.connection_events
       where workspace_id=$1 and connection_id=$2 order by created_at,id`,
      [workspaceA, created.id],
    );
    await ownerClient.query('rollback');
    ownerClient.release();
    await owner.end();
    expect(audit.rows.map(({ event_type }) => event_type)).toEqual([
      'connection.created',
      'connection.credential_accessed',
      'connection.secret_rotated',
      'connection.revoked',
    ]);
  });

  it('creates, resolves, fences, rotates, and revokes a Resend sending connection', async () => {
    const input = createInput({
      providerKey: 'email',
      authType: CONNECTION_AUTH_TYPE.resendApiKey,
      name: `Email ${randomUUID().slice(0, 8)}`,
    });
    const created = await api.createConnection(input);
    expect(created).toMatchObject({
      providerKey: 'email',
      authType: 'resend_api_key',
      status: 'active',
    });
    await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'email',
      workerId: 'email-worker',
      purpose: 'email.send_notification.execute',
    });
    await worker.assertConnectionSecretCurrent({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'email',
      expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
      secretVersionId: input.secretVersionId,
    });
    const nextVersion = randomUUID();
    await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
      expectedCurrentSecretVersionId: input.secretVersionId,
      expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
      secretVersionId: nextVersion,
      sealed: sealed(10),
      idempotencyKey: `rotate-email-${created.id}`,
      requestHash: createHash('sha256')
        .update(`rotate-email:${created.id}`)
        .digest('hex'),
    });
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'email',
        expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'email',
        workerId: 'email-worker',
        purpose: 'email.send_notification.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('rejects conflicting idempotency and active provider/name reuse without partial rows', async () => {
    const input = createInput();
    await api.createConnection(input);
    await expect(
      api.createConnection({
        ...input,
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    const duplicate = createInput({ name: input.name });
    await expect(api.createConnection(duplicate)).rejects.toBeInstanceOf(
      ConnectionConflictError,
    );
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from app.connection_secret_versions
         where id = $1`,
        [duplicate.secretVersionId],
      );
      expect(result.rows[0]?.count).toBe('0');
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('uses a compare-and-swap rotation and rejects cross-connection pointers', async () => {
    const first = createInput();
    const second = createInput();
    const createdFirst = await api.createConnection(first);
    await api.createConnection(second);
    const nextSecretVersionId = randomUUID();
    const rotated = await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: first.connectionId,
      expectedCurrentSecretVersionId: first.secretVersionId,
      secretVersionId: nextSecretVersionId,
      sealed: sealed(3),
      idempotencyKey: `rotate-${nextSecretVersionId}`,
      requestHash: '3'.repeat(64),
    });
    expect(rotated.currentSecretVersionId).toBe(nextSecretVersionId);
    await expect(
      api.findConnectionCreateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        idempotencyKey: first.idempotencyKey,
        requestHash: first.requestHash,
      }),
    ).resolves.toEqual(createdFirst);
    await expect(
      api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);
    await expect(
      api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '8'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(9),
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(8),
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '8'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(4),
        idempotencyKey: `rotate-stale-${first.connectionId}`,
        requestHash: '4'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionSecretVersionConflictError);
    await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: first.connectionId,
      expectedCurrentSecretVersionId: nextSecretVersionId,
      secretVersionId: randomUUID(),
      sealed: sealed(5),
      idempotencyKey: `rotate-later-${first.connectionId}`,
      requestHash: '5'.repeat(64),
    });
    await expect(
      api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);

    const pool = new Pool({ connectionString: databaseUrl(apiBaseUrl) });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      await client.query(
        `update app.connections set current_secret_version_id = $1
         where id = $2`,
        [second.secretVersionId, first.connectionId],
      );
      await expect(client.query('commit')).rejects.toSatisfy(pgCode('23503'));
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it('resolves only the active exact-provider current secret and audits worker access', async () => {
    const input = createInput();
    await api.createConnection(input);
    const resolved = await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      workerId: 'worker-connection-test',
      purpose: 'http.request.execute',
      traceId: 'trace-worker',
    });
    expect(resolved).toMatchObject({
      connection: { id: input.connectionId, status: 'active' },
      secretVersionId: input.secretVersionId,
      sealed: input.sealed,
    });
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: input.secretVersionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'slack',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('records bounded health truth and reauthorization state through worker grants', async () => {
    const input = createInput();
    await api.createConnection(input);
    const healthy = await worker.recordConnectionHealth({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      actorKind: 'worker',
      actorId: 'worker-connection-test',
      result: { ok: true },
    });
    expect(healthy.lastHealthyAt).toBeInstanceOf(Date);
    expect(healthy.lastErrorCode).toBeNull();
    const failed = await worker.recordConnectionHealth({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      actorKind: 'worker',
      actorId: 'worker-connection-test',
      result: {
        ok: false,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    });
    expect(failed).toMatchObject({
      status: 'reauthorization_required',
      lastErrorCode: 'connection.credential_rejected',
    });
  });

  it('durably owns, marks, completes, and exactly replays a safe connection test', async () => {
    const input = createInput();
    await api.createConnection(input);
    const idempotencyKey = `test-${input.connectionId}`;
    const requestHash = createHash('sha256')
      .update('https://provider.example.test/health')
      .digest('hex');
    const dispatchToken = randomUUID();
    const started = await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken,
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    expect(started).toMatchObject({
      kind: 'dispatch',
      dispatchToken,
    });
    const resolved = await api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken,
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    expect(resolved).toMatchObject({
      connection: { id: input.connectionId },
      secretVersionId: input.secretVersionId,
      sealed: input.sealed,
    });
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash: 'f'.repeat(64),
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    await api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken,
      secretVersionId: input.secretVersionId,
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    const completed = await api.completeConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken,
      secretVersionId: input.secretVersionId,
      outcome: { ok: true, httpStatus: 204 },
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    expect(completed).toMatchObject({
      connection: {
        id: input.connectionId,
        status: 'active',
        lastErrorCode: null,
      },
      outcome: { ok: true, httpStatus: 204 },
    });
    expect(completed.connection.lastHealthyAt).toBeInstanceOf(Date);
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'replay', result: completed });

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const evidence = await client.query<{
        credential_accesses: string;
        dispatch_audits: string;
        succeeded_events: string;
      }>(
        `select
           (select count(*)::text from app.connection_events
             where connection_id = $1
               and event_type = 'connection.credential_accessed')
             as credential_accesses,
           (select count(*)::text from app.connection_events
             where connection_id = $1
               and event_type = 'connection.test_succeeded')
             as succeeded_events,
           (select count(*)::text from app.audit_events
             where target_id = $1 and action = 'connection.test_dispatched')
             as dispatch_audits`,
        [input.connectionId],
      );
      expect(evidence.rows[0]).toEqual({
        credential_accesses: '1',
        dispatch_audits: '1',
        succeeded_events: '1',
      });
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('releases a pre-dispatch failure and never revives health after a revocation race', async () => {
    const input = createInput();
    await api.createConnection(input);
    const requestHash = 'a'.repeat(64);
    const idempotencyKey = `test-failure-${input.connectionId}`;
    const firstToken = randomUUID();
    await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken: firstToken,
    });
    await api.abandonConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: firstToken,
    });
    const secondToken = randomUUID();
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: secondToken,
      }),
    ).resolves.toMatchObject({ kind: 'dispatch', dispatchToken: secondToken });
    await api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
    });
    await api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
      secretVersionId: input.secretVersionId,
    });
    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    const completed = await api.completeConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
      secretVersionId: input.secretVersionId,
      outcome: { ok: true, httpStatus: 200 },
    });
    expect(completed.connection).toMatchObject({
      status: 'revoked',
      lastHealthyAt: null,
    });

    const revokedBeforeResolution = createInput();
    await api.createConnection(revokedBeforeResolution);
    const revokedToken = randomUUID();
    const revokedKey = `test-revoked-${revokedBeforeResolution.connectionId}`;
    await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: revokedBeforeResolution.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: revokedKey,
      requestHash,
      dispatchToken: revokedToken,
    });
    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: revokedBeforeResolution.connectionId,
    });
    await expect(
      api.resolveConnectionTestSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: revokedBeforeResolution.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: revokedKey,
        requestHash,
        dispatchToken: revokedToken,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    const rotatedAfterDispatch = createInput();
    await api.createConnection(rotatedAfterDispatch);
    const rotatedToken = randomUUID();
    const rotatedKey = `test-rotated-${rotatedAfterDispatch.connectionId}`;
    await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    await api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    await api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
      secretVersionId: rotatedAfterDispatch.secretVersionId,
    });
    await api.abandonConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `update app.idempotency_records
         set updated_at=clock_timestamp()-interval '25 hours'
         where workspace_id=$1 and operation='connection.test'
           and resource_id=$2 and result_ref->>'state'='dispatched'`,
        [workspaceA, rotatedAfterDispatch.connectionId],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: rotatedAfterDispatch.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: rotatedKey,
        requestHash,
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    const newSecretVersionId = randomUUID();
    await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedCurrentSecretVersionId: rotatedAfterDispatch.secretVersionId,
      secretVersionId: newSecretVersionId,
      sealed: sealed(7),
      idempotencyKey: `rotate-during-test-${rotatedAfterDispatch.connectionId}`,
      requestHash: '7'.repeat(64),
    });
    const staleCompletion = await api.completeConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
      secretVersionId: rotatedAfterDispatch.secretVersionId,
      outcome: {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    });
    expect(staleCompletion.connection).toMatchObject({
      status: 'active',
      currentSecretVersionId: newSecretVersionId,
      lastTestedAt: null,
      lastErrorCode: null,
    });
  });

  it('serializes concurrent same-name creations so exactly one wins atomically', async () => {
    const sharedName = `HTTP concurrent ${randomUUID().slice(0, 8)}`;
    const first = createInput({ name: sharedName });
    const second = createInput({ name: sharedName });
    const [firstOutcome, secondOutcome] = await Promise.all([
      api.createConnection(first).then(
        (value) => ({ kind: 'created' as const, value }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      api.createConnection(second).then(
        (value) => ({ kind: 'created' as const, value }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
    ]);
    const outcomes = [firstOutcome, secondOutcome];
    const created = outcomes.filter((outcome) => outcome.kind === 'created');
    const failed = outcomes.filter((outcome) => outcome.kind === 'failed');
    expect(created).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind === 'failed' && failed[0].error).toBeInstanceOf(
      ConnectionConflictError,
    );
    expect(created[0]?.kind === 'created' && created[0].value).toMatchObject({
      name: sharedName,
      status: 'active',
    });

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{ rows: string }>(
        `select count(*)::text as rows from app.connection_secret_versions
         where id = any($1::uuid[])`,
        [[first.secretVersionId, second.secretVersionId]],
      );
      // The loser must not leave an orphaned immutable secret version behind.
      expect(result.rows[0]?.rows).toBe('1');
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('admits exactly one concurrent rotation per expected current pointer', async () => {
    const input = createInput();
    await api.createConnection(input);
    const winnerSecretVersionId = randomUUID();
    const loserSecretVersionId = randomUUID();
    const attempt = (secretVersionId: string) =>
      api
        .rotateConnectionSecret({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          expectedCurrentSecretVersionId: input.secretVersionId,
          secretVersionId,
          sealed: sealed(secretVersionId === winnerSecretVersionId ? 6 : 9),
          idempotencyKey: `rotate-race-${secretVersionId}`,
          requestHash: createHash('sha256')
            .update(secretVersionId)
            .digest('hex'),
        })
        .then(
          (value) => ({ kind: 'rotated' as const, value }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
    const [firstOutcome, secondOutcome] = await Promise.all([
      attempt(winnerSecretVersionId),
      attempt(loserSecretVersionId),
    ]);
    const outcomes = [firstOutcome, secondOutcome];
    const rotated = outcomes.filter((outcome) => outcome.kind === 'rotated');
    const conflicts = outcomes.filter((outcome) => outcome.kind === 'failed');
    expect(rotated).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(
      conflicts[0]?.kind === 'failed' && conflicts[0].error,
    ).toBeInstanceOf(ConnectionSecretVersionConflictError);
    const winningVersionId =
      rotated[0]?.kind === 'rotated'
        ? rotated[0].value.currentSecretVersionId
        : undefined;
    const losingVersionId = [winnerSecretVersionId, loserSecretVersionId].find(
      (candidate) => candidate !== winningVersionId,
    );
    expect(winningVersionId).toBeDefined();
    expect(losingVersionId).toBeDefined();

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{
        current_pointer: string;
        loser_rows: string;
      }>(
        `select
           (select current_secret_version_id::text from app.connections
             where id = $1) as current_pointer,
           (select count(*)::text from app.connection_secret_versions
             where id = $2) as loser_rows`,
        [input.connectionId, losingVersionId],
      );
      // The pointer advanced exactly once and the losing version never
      // persisted, regardless of which claim won the race.
      expect(result.rows[0]?.current_pointer).toBe(winningVersionId);
      expect(result.rows[0]?.loser_rows).toBe('0');
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('forces RLS, hides other workspaces, and withholds history mutation', async () => {
    const input = createInput();
    await api.createConnection(input);
    await expect(
      api.getConnection(workspaceB, input.connectionId),
    ).resolves.toBeNull();
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceB,
        actorId: ownerB,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: `cross-workspace-${input.connectionId}`,
        requestHash: 'b'.repeat(64),
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    const apiReadinessPool = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    const workerReadinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(apiReadinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0066_operator_maintenance_rerun.sql',
      });
      await expect(
        checkDatabaseReadiness(workerReadinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0066_operator_maintenance_rerun.sql',
      });
    } finally {
      await Promise.all([apiReadinessPool.end(), workerReadinessPool.end()]);
    }

    const migration = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const client = await migration.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const grants = await client.query<{
        api_secret_update: boolean;
        events_force_rls: boolean;
        events_rls: boolean;
        secrets_force_rls: boolean;
        secrets_rls: boolean;
        worker_connection_insert: boolean;
        worker_secret_select: boolean;
      }>(`
        select
          has_table_privilege('pertexo_api', 'app.connection_secret_versions', 'UPDATE') as api_secret_update,
          has_table_privilege('pertexo_worker', 'app.connections', 'INSERT') as worker_connection_insert,
          has_table_privilege('pertexo_worker', 'app.connection_secret_versions', 'SELECT') as worker_secret_select,
          secret.relrowsecurity as secrets_rls,
          secret.relforcerowsecurity as secrets_force_rls,
          event.relrowsecurity as events_rls,
          event.relforcerowsecurity as events_force_rls
        from pg_class secret, pg_class event
        where secret.oid = 'app.connection_secret_versions'::regclass
          and event.oid = 'app.connection_events'::regclass
      `);
      expect(grants.rows[0]).toEqual({
        api_secret_update: false,
        events_force_rls: true,
        events_rls: true,
        secrets_force_rls: true,
        secrets_rls: true,
        worker_connection_insert: false,
        worker_secret_select: true,
      });
      await expect(
        client.query(
          `update app.connection_secret_versions
           set ciphertext = ciphertext where id = $1`,
          [input.secretVersionId],
        ),
      ).rejects.toSatisfy(pgCode('55000'));
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await migration.end();
    }
  });
});
