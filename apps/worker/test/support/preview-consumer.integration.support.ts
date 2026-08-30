import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';

import { dropDisconnectedDatabase } from './disposable-database.js';

import {
  acceptPreviewRun,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  databaseSchema,
  parseDatabaseConfig,
  parseWorkspaceId,
  withTenantScopedClient,
  type AcceptPreviewRunInput,
} from '@pertexo/database';
import { platformExecutableRegistryHistory } from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
} from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';

export const workerTransportIntegrationEnabled =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
export const artifactStoreIntegrationEnabled =
  workerTransportIntegrationEnabled &&
  process.env.ARTIFACT_STORE_INTEGRATION === 'true';
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
export const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
export const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
export const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
export const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/13';
  return parsed.toString();
})();

const databaseName = `pertexo_test_preview_transport_${randomUUID().replaceAll('-', '')}`;
export const workspaceId = randomUUID();
const actorUserId = randomUUID();
const workflowId = randomUUID();

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const apiPool = new Pool({ connectionString: databaseUrl(apiUrl), max: 4 });
export const workerPool = new Pool({
  connectionString: databaseUrl(workerUrl),
  max: 4,
});
const ownerPool = new Pool({
  connectionString: databaseUrl(migrationUrl),
  max: 1,
});

async function withOwner<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function clearNodeAttemptQueue(): Promise<void> {
  const parsed = new URL(redisUrl);
  const queue = new Queue('node-attempts', {
    connection: {
      db: Number(parsed.pathname.slice(1)),
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      ...(parsed.password === ''
        ? {}
        : { password: decodeURIComponent(parsed.password) }),
    },
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

async function seedIdentity(): Promise<void> {
  await withOwner(async (client) => {
    await client.query(`
      create table app.preview_process_provider_effects (
        workspace_id uuid not null references app.workspaces(id) on delete cascade,
        effect_key varchar(200) not null,
        invocation_count integer not null check (invocation_count > 0),
        primary key (workspace_id,effect_key)
      );
      alter table app.preview_process_provider_effects enable row level security;
      alter table app.preview_process_provider_effects force row level security;
      create policy preview_process_provider_effects_workspace
        on app.preview_process_provider_effects
        using (workspace_id::text =
          nullif(current_setting('app.workspace_id', true), ''))
        with check (workspace_id::text =
          nullif(current_setting('app.workspace_id', true), ''));
      revoke all on app.preview_process_provider_effects from public;
      grant select,insert,update on app.preview_process_provider_effects
        to pertexo_worker;
    `);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, $3, 'active')`,
      [actorUserId, 'preview-transport@example.test', 'Preview Transport'],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, $2, $3, 'active', $4)`,
      [
        workspaceId,
        'Preview Transport',
        `preview-transport-${randomUUID().slice(0, 8)}`,
        actorUserId,
      ],
    );
    // Forced RLS applies to the owner too; tenant-scoped inserts need
    // transaction-local context.
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workspace_memberships
         (workspace_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [workspaceId, actorUserId],
    );
    await client.query(
      `insert into app.workflows (id, workspace_id, name, lifecycle_status,
         activation_status, created_by)
       values ($1, $2, $3, 'active', 'inactive', $4)`,
      [workflowId, workspaceId, 'Preview transport target', actorUserId],
    );
    await client.query(
      `insert into app.workflow_drafts
         (workflow_id, workspace_id, revision, schema_version, graph_json,
          updated_by)
       values ($1, $2, 3, 1, $3::jsonb, $4)`,
      [
        workflowId,
        workspaceId,
        '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}',
        actorUserId,
      ],
    );
  });
}

let acceptanceSequence = 0;
// This worker artifact activates its own derived release through the
// audited maintenance seam (exactly like production rollouts), so previews
// pin an identity this binary provably supports.
let activeRelease = {
  epoch: 1,
  fingerprint: '',
};

async function activateArtifactRelease(): Promise<void> {
  const rows = await withOwner((client) =>
    client.query<{ epoch: number; fingerprint: string }>(
      `select epoch,fingerprint from app.node_compatibility_current`,
    ),
  );
  const current = rows.rows[0];
  if (current === undefined)
    throw new Error('seeded compatibility pointer missing');
  const support = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory('core').map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const target = support.descriptions.at(-1);
  if (target === undefined) throw new Error('cohort history is empty');
  const databaseConfig = parseDatabaseConfig({
    connectionString: databaseUrl(migrationUrl),
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  const maintenance = createCompatibilityReleaseMaintenance(databaseConfig);
  const predecessorRows = await withOwner((client) =>
    client.query<{ catalog_json: unknown }>(
      `select catalog_json from app.node_compatibility_releases
       where epoch=$1 and fingerprint=$2`,
      [current.epoch, current.fingerprint],
    ),
  );
  const rawCatalog = predecessorRows.rows[0]?.catalog_json;
  if (rawCatalog === null || rawCatalog === undefined)
    throw new Error('seeded release catalog missing');
  const expectedPredecessor = {
    catalogJson:
      typeof rawCatalog === 'string' ? rawCatalog : JSON.stringify(rawCatalog),
    epoch: current.epoch,
    fingerprint: current.fingerprint,
  };
  // Rolling readiness accepts exactly the current/target pair, so the
  // probes must know both identities.
  const pairDescriptions = [
    {
      catalogJson:
        typeof rawCatalog === 'string'
          ? rawCatalog
          : JSON.stringify(rawCatalog),
      epoch: current.epoch,
      fingerprint: current.fingerprint,
    },
    target,
  ];
  const apiProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 1 }),
    pairDescriptions,
  );
  const workerProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl), max: 1 }),
    pairDescriptions,
  );
  const deploymentId = `preview-transport-${randomUUID()}`;
  const approvalId = randomUUID();

  try {
    await maintenance.prepare({
      actorId: 'preview-transport-integration',
      actorKind: 'deployment',
      expectedPredecessor,
      reason: 'Activate the transport-proof cohort',
      target,
    });
    await expect(apiProbe.checkTarget(target)).resolves.toMatchObject({
      role: 'pertexo_api',
    });
    await expect(workerProbe.checkTarget(target)).resolves.toMatchObject({
      role: 'pertexo_worker',
    });
    await maintenance.recordPreactivation({
      artifactId: 'preview-transport-api',
      checkId: randomUUID(),
      deploymentId,
      roleKind: 'api',
      target,
    });
    await maintenance.recordPreactivation({
      artifactId: 'preview-transport-worker',
      checkId: randomUUID(),
      deploymentId,
      roleKind: 'worker',
      target,
    });
    await maintenance.approve({
      actorId: 'preview-transport-integration',
      approvalId,
      deploymentId,
      reason: 'Approve the preview transport cohort',
      requiredApiArtifacts: ['preview-transport-api'],
      requiredWorkerArtifacts: ['preview-transport-worker'],
      target,
    });
    await maintenance.activate({
      activationId: randomUUID(),
      actorId: 'preview-transport-integration',
      actorKind: 'deployment',
      approvalId,
      expectedPredecessor,
      reason: 'Activate for preview transport proof',
    });
    activeRelease = { epoch: target.epoch, fingerprint: target.fingerprint };
  } finally {
    await Promise.allSettled([
      maintenance.close(),
      apiProbe.close(),
      workerProbe.close(),
    ]);
  }
}

export function acceptanceInput(
  traceparent: string,
  overrides: Partial<AcceptPreviewRunInput> = {},
): AcceptPreviewRunInput {
  acceptanceSequence += 1;
  return {
    actorUserId,
    compatibilityReleaseEpoch: activeRelease.epoch,
    compatibilityReleaseFingerprint: activeRelease.fingerprint,
    definitionKey: 'core.set',
    definitionVersion: 1,
    draftFingerprint: 'b'.repeat(64),
    draftRevision: 3,
    dryRun: 'not_supported',
    executableNode: {
      config: {},
      configVersion: 1,
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {
        hello: { kind: 'run_input', path: '$.hello' },
      },
      connectionRefs: {},
    },
    executorKey: 'core.set',
    executorVersion: 1,
    executionDeadlineAt: new Date(Date.now() + 5 * 60 * 1_000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    input: { kind: 'manual' as const, value: { hello: 'transport' } },
    keyHash: createHash('sha256')
      .update(`transport-key-${String(acceptanceSequence)}`)
      .digest('hex'),
    mayContactProvider: false,
    mayCauseExternalSideEffect: false,
    nodeId: 'node-1',
    operation: 'preview.execute',
    requestHash: createHash('sha256')
      .update(`transport-request-${String(acceptanceSequence)}`)
      .digest('hex'),
    scope: `workflow:${workflowId}:node-1`,
    sideEffectClass: 'safe',
    traceparent,
    workflowId,
    ...overrides,
  };
}

export interface AcceptedDelivery {
  accepted: Awaited<ReturnType<typeof acceptPreviewRun>>;
  job: {
    data: {
      outboxEventId: string;
      previewAttemptId: string;
      previewRunId: string;
      schemaVersion: 1;
      traceparent: string;
      workspaceId: string;
    };
    name: 'execute-preview-attempt';
  };
}

export async function acceptDelivery(
  traceparent: string,
  overrides: Partial<AcceptPreviewRunInput> = {},
): Promise<AcceptedDelivery> {
  const input = acceptanceInput(traceparent, overrides);
  const accepted = await withTenantAccept(input);
  return {
    accepted,
    job: {
      data: {
        outboxEventId: accepted.outboxEventId,
        previewAttemptId: accepted.previewAttemptId,
        previewRunId: accepted.previewRunId,
        schemaVersion: 1,
        traceparent,
        workspaceId,
      },
      name: 'execute-preview-attempt',
    },
  };
}

export function withTenantAccept(input: AcceptPreviewRunInput) {
  return withTenantScopedClient(apiPool, { workspaceId }, async (client) =>
    acceptPreviewRun(
      {
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(workspaceId),
      },
      input,
    ),
  );
}

export async function waitFor<T>(
  poll: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMillis = 15_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await poll();
    if (done(value)) return value;
    if (Date.now() - startedAt >= timeoutMillis)
      throw new Error(`condition not met within ${String(timeoutMillis)}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function previewState(previewRunId: string) {
  return withTenantScopedWorker((client) =>
    client.query<{
      attempt_status: string;
      attempt_fence: string | number;
      dispatch_marked_at: Date | null;
      inbox_completed_count: string;
      inbox_count: string;
      lease_expired: boolean;
      output_ref: unknown;
      run_status: string;
      safe_error_code: string | null;
    }>(
      `select run.status as run_status,
              run.output_ref,
              run.safe_error_code,
              attempt.status as attempt_status,
              attempt.fence_token::text as attempt_fence,
              attempt.dispatch_marked_at,
              (attempt.lease_expires_at is null
                or attempt.lease_expires_at <= clock_timestamp())
                as lease_expired,
              (select count(*)::text from app.inbox_receipts receipt
                where receipt.workspace_id=run.workspace_id
                  and receipt.consumer_name='preview-attempt-worker'
                  and receipt.message_id=(
                    select event.id from app.outbox_events event
                     where event.workspace_id=run.workspace_id
                       and event.aggregate_id=run.id
                       and event.job_name='execute-preview-attempt'
                     order by event.created_at,event.id
                     limit 1)) as inbox_count,
              (select count(receipt.completed_at)::text
                 from app.inbox_receipts receipt
                where receipt.workspace_id=run.workspace_id
                  and receipt.consumer_name='preview-attempt-worker'
                  and receipt.message_id=(
                    select event.id from app.outbox_events event
                     where event.workspace_id=run.workspace_id
                       and event.aggregate_id=run.id
                       and event.job_name='execute-preview-attempt'
                     order by event.created_at,event.id
                     limit 1))
                as inbox_completed_count
       from app.preview_runs run
       join app.preview_attempts attempt
         on attempt.workspace_id = run.workspace_id
        and attempt.preview_run_id = run.id
       where run.workspace_id=$1 and run.id=$2`,
      [workspaceId, previewRunId],
    ),
  ).then((result) => result.rows[0]);
}

export function previewTerminalFacts(previewRunId: string) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query<{ audit_count: string; usage_count: string }>(
      `select
         (select count(*)::text from app.audit_events audit
           where audit.workspace_id=$1
             and audit.action='preview.execution_terminal'
             and audit.target_type='preview-run'
             and audit.target_id=$2) as audit_count,
         (select count(*)::text from app.usage_events usage
           where usage.workspace_id=$1
             and usage.category='preview_execution'
             and usage.resource_type='preview-run'
             and usage.resource_id=$2) as usage_count`,
      [workspaceId, previewRunId],
    ),
  ).then((result) => result.rows[0]);
}

export function providerEffectCount(effectKey: string): Promise<number> {
  return withTenantScopedWorker((client) =>
    client.query<{ invocation_count: number }>(
      `select invocation_count from app.preview_process_provider_effects
       where workspace_id=$1 and effect_key=$2`,
      [workspaceId, effectKey],
    ),
  ).then((result) => result.rows[0]?.invocation_count ?? 0);
}

export function withTenantScopedWorker<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(workerPool, { workspaceId }, work);
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher, pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  // Migration runs through the database package's own reviewed CLI so this
  // suite exercises exactly the shipped migration path.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@pertexo/database', 'exec', 'tsx', 'src/migrate.ts'],
      {
        stdio: 'inherit',
        cwd: new URL('../../../../', import.meta.url).pathname,
        env: {
          ...process.env,
          DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
        },
      },
    );
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`preview transport migration failed: ${String(code)}`));
    });
  });
  await seedIdentity();
  await activateArtifactRelease();
  await clearNodeAttemptQueue();
}, 60_000);

afterAll(async () => {
  await clearNodeAttemptQueue().catch(() => undefined);
  await Promise.allSettled([apiPool.end(), workerPool.end(), ownerPool.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

export function deliveryJobData(delivery: AcceptedDelivery) {
  return delivery.job.data;
}

export function validTraceparent(sequence: number): string {
  void sequence;
  return '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(15) + '0-01';
}
