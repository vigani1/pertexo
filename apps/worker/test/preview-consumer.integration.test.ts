import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dropDisconnectedDatabase } from './support/disposable-database.js';

import {
  acceptPreviewRun,
  canonicalOutboxPayloadChecksum,
  claimPreviewDelivery,
  completePreviewAttempt,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createOutboxDispatcherDatabase,
  databaseSchema,
  parseDatabaseConfig,
  parseWorkspaceId,
  markPreviewDispatched,
  PREVIEW_STATUS,
  withTenantScopedClient,
  type AcceptPreviewRunInput,
} from '@pertexo/database';
import {
  platformExecutableRegistryHistory,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME, parseQueueJob } from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
} from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import {
  createDatabasePreviewAttemptRunStore,
  createPlatformPreviewNodeInvoker,
} from '../src/execution/preview-attempt-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import { createWorkerNodeRuntimeCapabilities } from '../src/execution/node-runtime-capabilities.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const itArtifactIntegration =
  enabled && process.env.ARTIFACT_STORE_INTEGRATION === 'true' ? it : it.skip;
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
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/13';
  return parsed.toString();
})();

const databaseName = `pertexo_test_preview_transport_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorUserId = randomUUID();
const workflowId = randomUUID();

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const apiPool = new Pool({ connectionString: databaseUrl(apiUrl), max: 4 });
const workerPool = new Pool({
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

function acceptanceInput(
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

interface AcceptedDelivery {
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

async function acceptDelivery(
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

function withTenantAccept(input: AcceptPreviewRunInput) {
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

async function waitFor<T>(
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

interface PreviewCrashChild {
  readonly evidence: Promise<Record<string, unknown>>;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  next(
    predicate?: (value: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  kill(): Promise<NodeJS.Signals | null>;
}

const activeCrashChildren = new Set<PreviewCrashChild>();

function spawnPreviewCrashChild(
  input: Record<string, unknown>,
): PreviewCrashChild {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      new URL('./preview-reconciliation-process-fixture.mjs', import.meta.url)
        .pathname,
    ],
    {
      cwd: new URL('../../../', import.meta.url).pathname,
      env: {
        ...process.env,
        PREVIEW_RECONCILIATION_CHILD_INPUT: JSON.stringify(input),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (value: Record<string, unknown>) => boolean;
    resolve: (value: Record<string, unknown>) => void;
  }[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiterIndex = waiters.findIndex(({ predicate }) =>
        predicate(message),
      );
      if (waiterIndex === -1) messages.push(message);
      else waiters.splice(waiterIndex, 1)[0]?.resolve(message);
    }
  });
  const next = async (
    predicate: (value: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> => {
    const existingIndex = messages.findIndex(predicate);
    if (existingIndex !== -1) return messages.splice(existingIndex, 1)[0] ?? {};
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        waiters.push({ predicate, resolve });
      }),
      exited.then(({ code, signal }) => {
        throw new Error(
          `preview crash child exited before evidence: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        );
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`preview crash child evidence timeout: ${stderr}`));
        }, 15_000);
      }),
    ]);
  };
  const selected: PreviewCrashChild = {
    evidence: next(),
    exited,
    next,
    kill: async (): Promise<NodeJS.Signals | null> => {
      child.kill('SIGKILL');
      return (await exited).signal;
    },
  };
  activeCrashChildren.add(selected);
  void exited.then(() => activeCrashChildren.delete(selected));
  return selected;
}

function previewState(previewRunId: string) {
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

function previewTerminalFacts(previewRunId: string) {
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

function providerEffectCount(effectKey: string): Promise<number> {
  return withTenantScopedWorker((client) =>
    client.query<{ invocation_count: number }>(
      `select invocation_count from app.preview_process_provider_effects
       where workspace_id=$1 and effect_key=$2`,
      [workspaceId, effectKey],
    ),
  ).then((result) => result.rows[0]?.invocation_count ?? 0);
}

function withTenantScopedWorker<T>(
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
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
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
        cwd: new URL('../../../', import.meta.url).pathname,
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
  await Promise.allSettled(
    [...activeCrashChildren].map(async (child) => child.kill()),
  );
  await clearNodeAttemptQueue().catch(() => undefined);
  await Promise.allSettled([apiPool.end(), workerPool.end(), ownerPool.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describeIntegration('preview execution real transport', () => {
  itArtifactIntegration(
    'removes an expired preview and its object through the real maintenance path',
    async () => {
      const artifactConfig = parseArtifactStoreConfig(process.env);
      const previewDeadline = new Date(Date.now() + 2_000);
      const traceparent = validTraceparent(90);
      const accepted = await withTenantAccept(
        acceptanceInput(traceparent, { expiresAt: previewDeadline }),
      );
      const capabilities = await createWorkerNodeRuntimeCapabilities({
        artifactStore: artifactConfig,
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
        }),
      });
      const verifier = createArtifactStore(artifactConfig);
      const artifacts = capabilities.factories.artifacts?.({
        artifactRetentionDeadline: previewDeadline,
        attemptId: accepted.previewAttemptId,
        attemptNumber: 1,
        invocationKey: 'preview:node-1',
        nodeId: 'node-1',
        nodeRunId: accepted.previewRunId,
        previewRunId: accepted.previewRunId,
        runId: accepted.previewRunId,
        workerId: 'preview-cleanup-integration',
        workspaceId,
      });
      if (artifacts === undefined)
        throw new Error('preview artifact capability missing');
      const reference = await artifacts.write({
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          yield new TextEncoder().encode('preview cleanup proof');
        })(),
        maxBytes: 1_024,
        mediaType: 'application/octet-stream',
        purpose: 'node-output',
        signal: new AbortController().signal,
      });
      const executionPayload = {
        schemaVersion: 1 as const,
        workspaceId,
        outboxEventId: accepted.outboxEventId,
        previewRunId: accepted.previewRunId,
        previewAttemptId: accepted.previewAttemptId,
        traceparent,
      };
      const workerId = 'preview-cleanup-integration';
      const claimed = await claimPreviewDelivery(workerPool, {
        delivery: {
          outboxEventId: accepted.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(executionPayload),
        },
        leaseDurationSeconds: 30,
        previewAttemptId: accepted.previewAttemptId,
        previewRunId: accepted.previewRunId,
        workerId,
        workspaceId,
      });
      if (claimed.kind !== 'claimed')
        throw new Error('preview cleanup terminal claim missing');
      await completePreviewAttempt(workerPool, {
        delivery: {
          outboxEventId: accepted.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(executionPayload),
        },
        lease: claimed.lease,
        outcome: {
          safeErrorCode: 'preview.cleanup_fixture',
          status: PREVIEW_STATUS.failed,
        },
        workerId,
      });
      const cleanupRuntime = await createPreviewMaintenanceRuntime({
        artifactStore: artifactConfig,
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
        }),
        redisUrl,
      });
      const dispatcher = createOutboxDispatcherDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          ownerRole: 'pertexo_owner',
        }),
      );
      const producer = createQueueProducer({ redisUrl });
      try {
        await cleanupRuntime.consumer.waitUntilReady(5_000);
        await expect(
          verifier.head({ artifactId: reference.artifactId, workspaceId }),
        ).resolves.toMatchObject({ artifactId: reference.artifactId });
        const batch = await waitFor(
          () =>
            dispatcher.claimBatch({
              enabledJobNames: [JOB_NAME.sweepExpiredPreviews],
              leaseDurationMillis: 5_000,
              leaseOwner: 'preview-cleanup-integration',
              leaseToken: randomUUID(),
              limit: 10,
              maxAttempts: 3,
            }),
          (value) => value.events.length > 0,
        );
        const event = batch.events.find(
          (candidate) => candidate.aggregateId === accepted.previewRunId,
        );
        if (event === undefined)
          throw new Error('due preview cleanup outbox missing');
        await producer.publish(
          parseQueueJob({ name: event.jobName, data: event.payload }),
        );
        await dispatcher.markPublished(event.id, event.leaseToken);
        await waitFor(
          async () => {
            const due = await dispatcher.claimBatch({
              enabledJobNames: [JOB_NAME.sweepExpiredPreviews],
              leaseDurationMillis: 5_000,
              leaseOwner: 'preview-cleanup-integration',
              leaseToken: randomUUID(),
              limit: 10,
              maxAttempts: 3,
            });
            for (const successor of due.events) {
              await producer.publish(
                parseQueueJob({
                  name: successor.jobName,
                  data: successor.payload,
                }),
              );
              await dispatcher.markPublished(
                successor.id,
                successor.leaseToken,
              );
            }
            return withTenantScopedClient(
              workerPool,
              { workspaceId },
              (client) =>
                client.query<{ count: string }>(
                  `select count(*)::text as count from app.preview_runs
                   where workspace_id=$1 and id=$2`,
                  [workspaceId, accepted.previewRunId],
                ),
            ).then((result) => result.rows[0]?.count ?? 'missing');
          },
          (count) => count === '0',
        );
        await expect(
          verifier.head({ artifactId: reference.artifactId, workspaceId }),
        ).resolves.toBeNull();
      } finally {
        await Promise.allSettled([
          cleanupRuntime.close(),
          dispatcher.close(),
          producer.close(),
          capabilities.close(),
        ]);
        await verifier
          .delete({ artifactId: reference.artifactId, workspaceId })
          .catch(() => undefined);
        verifier.close();
      }
    },
  );

  it('executes an accepted preview through BullMQ once and duplicates safely', async () => {
    const delivery = await acceptDelivery(validTraceparent(1));
    const previewStore = createDatabasePreviewAttemptRunStore(
      parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
    );
    const registry = createPlatformNodeRegistryForRelease(
      platformServingRegistryRelease('core'),
    );
    const runtime = await createNodeAttemptRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      heartbeatIntervalMillis: 200,
      leaseDurationSeconds: 10,
      preview: {
        invoker: createPlatformPreviewNodeInvoker({
          releaseCohort: 'core',
          registry,
        }),
        runStore: previewStore,
      },
      redisUrl,
      releaseCohort: 'core',
      workerId: `preview-transport-${randomUUID().slice(0, 8)}`,
    });
    const producer = createQueueProducer({ redisUrl });
    const queue = new Queue('node-attempts', {
      connection: (() => {
        const parsed = new URL(redisUrl);
        return {
          db: Number(parsed.pathname.slice(1)),
          host: parsed.hostname,
          port: Number(parsed.port || 6379),
          ...(parsed.password === ''
            ? {}
            : { password: decodeURIComponent(parsed.password) }),
        };
      })(),
    });
    try {
      await Promise.all([
        runtime.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      const job = await producer.publish({
        data: delivery.job.data,
        name: delivery.job.name,
      });
      expect(job.jobId).toBe(`outbox-${delivery.accepted.outboxEventId}`);

      const state = await waitFor(
        () => previewState(delivery.accepted.previewRunId),
        (value) => value?.run_status === 'succeeded',
      );
      expect(state?.attempt_fence).toBe('1');
      // core.set is a safe node: dispatch evidence is not required before
      // its pure execution, so no marker exists for this preview.
      expect(state?.dispatch_marked_at).toBeNull();
      expect(JSON.parse(String(state?.output_ref))).toMatchObject({
        value: { hello: 'transport' },
      });

      const receipts = await withTenantScopedWorker((client) =>
        client.query<{ count: string; completed: string }>(
          `select count(*)::text as count,
                  count(completed_at)::text as completed
           from app.inbox_receipts
           where consumer_name='preview-attempt-worker' and message_id=$1`,
          [delivery.accepted.outboxEventId],
        ),
      );
      expect(receipts.rows[0]).toEqual({ completed: '1', count: '1' });

      // Exact redelivery of the published job must not re-execute: the
      // durable outcome, fence, and receipt stay untouched.
      const before = await previewState(delivery.accepted.previewRunId);
      await producer.publish({
        data: delivery.job.data,
        name: delivery.job.name,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await previewState(delivery.accepted.previewRunId);
      expect(after).toEqual(before);
      expect(after?.attempt_fence).toBe('1');
    } finally {
      await Promise.allSettled([
        runtime.close(),
        producer.close(),
        queue.close(),
      ]);
    }

    // The checksum helper stays exercised so drift between transport bytes
    // and the durable aggregate fails this suite loudly.
    expect(
      canonicalOutboxPayloadChecksum({
        ...deliveryJobData(delivery),
      }),
    ).toBe(canonicalOutboxPayloadChecksum(deliveryJobData(delivery)));
  });

  it('delivers an expired unsafe lease to the durable reconciler through the outbox', async () => {
    const traceparent = validTraceparent(2);
    const accepted = await withTenantAccept(
      acceptanceInput(traceparent, {
        mayContactProvider: true,
        mayCauseExternalSideEffect: true,
        sideEffectClass: 'unsafe',
      }),
    );
    const executionPayload = {
      schemaVersion: 1 as const,
      workspaceId,
      outboxEventId: accepted.outboxEventId,
      previewRunId: accepted.previewRunId,
      previewAttemptId: accepted.previewAttemptId,
      traceparent,
    };
    const crashWorkerId = `preview-crash-${randomUUID().slice(0, 8)}`;
    const claimed = await claimPreviewDelivery(workerPool, {
      delivery: {
        outboxEventId: accepted.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(executionPayload),
      },
      leaseDurationSeconds: 1,
      previewAttemptId: accepted.previewAttemptId,
      previewRunId: accepted.previewRunId,
      workerId: crashWorkerId,
      workspaceId,
    });
    if (claimed.kind !== 'claimed') throw new Error('preview claim missing');
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: crashWorkerId,
    });

    const reconciliationRuntime = await createPreviewMaintenanceRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      redisUrl,
    });
    const dispatcher = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        ownerRole: 'pertexo_owner',
      }),
    );
    const producer = createQueueProducer({ redisUrl });
    try {
      await Promise.all([
        reconciliationRuntime.consumer.waitUntilReady(5_000),
        dispatcher.checkReadiness(),
        producer.waitUntilReady(5_000),
      ]);
      const batch = await waitFor(
        () =>
          dispatcher.claimBatch({
            enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
            leaseDurationMillis: 5_000,
            leaseOwner: 'preview-reconciliation-integration',
            leaseToken: randomUUID(),
            limit: 10,
            maxAttempts: 3,
          }),
        (value) => value.events.length > 0,
      );
      const event = batch.events.find(
        (candidate) => candidate.aggregateId === accepted.previewRunId,
      );
      if (event === undefined)
        throw new Error('due preview reconciliation outbox missing');
      const job = parseQueueJob({ name: event.jobName, data: event.payload });
      await producer.publish(job);
      await dispatcher.markPublished(event.id, event.leaseToken);

      const state = await waitFor(
        () => previewState(accepted.previewRunId),
        (value) => value?.run_status === 'outcome_unknown',
      );
      expect(state).toMatchObject({
        run_status: 'outcome_unknown',
        safe_error_code: 'preview.outcome_unknown',
      });
      expect(Number(state?.attempt_fence)).toBe(
        claimed.lease.attemptFenceToken + 1,
      );
    } finally {
      await Promise.allSettled([
        reconciliationRuntime.close(),
        dispatcher.close(),
        producer.close(),
      ]);
    }
  });

  it('preserves the four preview dispatch and acknowledgement crash boundaries', async () => {
    const cases = [
      {
        expectedBarrier: 'preview.before_dispatch_marker_commit',
        expectedDispatch: false,
        expectedProviderCount: 0,
        expectedReconciledStatus: 'queued',
        mode: 'before-dispatch-commit',
      },
      {
        expectedBarrier: 'preview.dispatch_marker_committed_before_provider',
        expectedDispatch: true,
        expectedProviderCount: 0,
        expectedReconciledStatus: 'outcome_unknown',
        mode: 'after-dispatch-before-provider',
      },
      {
        expectedBarrier: 'preview.provider_completed_before_outcome_commit',
        expectedDispatch: true,
        expectedProviderCount: 1,
        expectedReconciledStatus: 'outcome_unknown',
        mode: 'after-provider-before-outcome',
      },
      {
        expectedBarrier: 'preview.outcome_committed_before_queue_ack',
        expectedDispatch: true,
        expectedProviderCount: 1,
        expectedReconciledStatus: 'succeeded',
        mode: 'after-outcome-before-ack',
      },
    ] as const;
    const fixtures: {
      delivery: AcceptedDelivery;
      effectKey: string;
      jobId: string;
      selected: (typeof cases)[number];
    }[] = [];
    const producer = createQueueProducer({ redisUrl });
    const lockRedis = new Redis(redisUrl);
    const queue = new Queue('node-attempts', {
      connection: (() => {
        const parsed = new URL(redisUrl);
        return {
          db: Number(parsed.pathname.slice(1)),
          host: parsed.hostname,
          port: Number(parsed.port || 6379),
          ...(parsed.password === ''
            ? {}
            : { password: decodeURIComponent(parsed.password) }),
        };
      })(),
    });
    await producer.waitUntilReady(5_000);

    try {
      for (const [index, selected] of cases.entries()) {
        const delivery = await acceptDelivery(validTraceparent(index + 40), {
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          sideEffectClass: 'unsafe',
        });
        const effectKey = `preview-process-${selected.mode}-${randomUUID()}`;
        const child = spawnPreviewCrashChild({
          leaseDurationSeconds: 1,
          mode: selected.mode,
          providerEffectKey: effectKey,
          redisUrl,
          workerId: `preview-process-${String(index)}-${randomUUID().slice(0, 8)}`,
          workerUrl: databaseUrl(workerUrl),
          workspaceId,
        });
        await expect(child.evidence).resolves.toMatchObject({
          injectionPoint: 'preview.consumer_ready',
        });
        const job = await producer.publish({
          data: delivery.job.data,
          name: delivery.job.name,
        });
        const evidence = await child.next(
          (message) => message.injectionPoint === selected.expectedBarrier,
        );
        expect(evidence.injectionPoint).toBe(selected.expectedBarrier);
        await expect(queue.getJob(job.jobId)).resolves.not.toBeUndefined();
        await expect(
          queue.getJob(job.jobId).then((published) => published?.getState()),
        ).resolves.toBe('active');

        const atBarrier = await previewState(delivery.accepted.previewRunId);
        expect(atBarrier).toMatchObject({
          attempt_fence: '1',
          attempt_status:
            selected.mode === 'after-outcome-before-ack'
              ? 'succeeded'
              : 'running',
          inbox_completed_count:
            selected.mode === 'after-outcome-before-ack' ? '1' : '0',
          inbox_count: '1',
          run_status:
            selected.mode === 'after-outcome-before-ack'
              ? 'succeeded'
              : 'running',
        });
        expect(
          await previewTerminalFacts(delivery.accepted.previewRunId),
        ).toEqual({
          audit_count: selected.mode === 'after-outcome-before-ack' ? '1' : '0',
          usage_count: selected.mode === 'after-outcome-before-ack' ? '1' : '0',
        });
        expect(atBarrier?.dispatch_marked_at === null).toBe(
          !selected.expectedDispatch,
        );
        expect(await providerEffectCount(effectKey)).toBe(
          selected.expectedProviderCount,
        );
        if (selected.mode === 'after-outcome-before-ack') {
          expect(JSON.parse(String(atBarrier?.output_ref))).toMatchObject({
            value: { executed: true, providerEffectKey: effectKey },
          });
        } else {
          expect(atBarrier?.output_ref).toBeNull();
        }
        expect(await child.kill()).toBe('SIGKILL');
        fixtures.push({ delivery, effectKey, jobId: job.jobId, selected });
      }

      const dispatcher = createOutboxDispatcherDatabase(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          ownerRole: 'pertexo_owner',
        }),
      );
      const reconciliationRuntime = await createPreviewMaintenanceRuntime({
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
        }),
        redisUrl,
      });
      try {
        await reconciliationRuntime.consumer.waitUntilReady(5_000);
        await dispatcher.checkReadiness();
        const reconcilable = fixtures.slice(0, 3);
        await waitFor(
          () =>
            Promise.all(
              reconcilable.map(({ delivery }) =>
                previewState(delivery.accepted.previewRunId),
              ),
            ),
          (states) => states.every((state) => state?.lease_expired === true),
        );
        const targetRunIds = new Set(
          reconcilable.map(({ delivery }) => delivery.accepted.previewRunId),
        );
        const selectedEvents = new Map<
          string,
          Awaited<ReturnType<typeof dispatcher.claimBatch>>['events'][number]
        >();
        const events = await waitFor(
          async () => {
            const batch = await dispatcher.claimBatch({
              enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
              leaseDurationMillis: 5_000,
              leaseOwner: 'preview-process-crash-matrix',
              leaseToken: randomUUID(),
              limit: 20,
              maxAttempts: 3,
            });
            for (const event of batch.events) {
              if (targetRunIds.has(event.aggregateId))
                selectedEvents.set(event.id, event);
            }
            return [...selectedEvents.values()];
          },
          (value) => value.length === reconcilable.length,
        );
        await Promise.all(
          events.map(async (event) => {
            const job = parseQueueJob({
              name: event.jobName,
              data: event.payload,
            });
            if (job.name !== JOB_NAME.reconcilePreviewAttempt)
              throw new Error('claimed preview reconciliation job mismatch');
            await producer.publish(job);
            await dispatcher.markPublished(event.id, event.leaseToken);
          }),
        );

        const reconciled = await waitFor(
          () =>
            Promise.all(
              reconcilable.map(({ delivery }) =>
                previewState(delivery.accepted.previewRunId),
              ),
            ),
          (states) =>
            states.every(
              (state, index) =>
                state?.run_status ===
                reconcilable[index]?.selected.expectedReconciledStatus,
            ),
        );
        expect(reconciled.map((state) => state?.run_status)).toEqual([
          'queued',
          'outcome_unknown',
          'outcome_unknown',
        ]);
        expect(reconciled.map((state) => state?.attempt_fence)).toEqual([
          '2',
          '2',
          '2',
        ]);
        expect(
          await Promise.all(
            reconcilable.map(({ delivery }) =>
              previewTerminalFacts(delivery.accepted.previewRunId),
            ),
          ),
        ).toEqual([
          { audit_count: '0', usage_count: '0' },
          { audit_count: '1', usage_count: '1' },
          { audit_count: '1', usage_count: '1' },
        ]);
        expect(reconciled.map((state) => state?.inbox_count)).toEqual([
          '1',
          '1',
          '1',
        ]);
        expect(
          await Promise.all(
            reconcilable.map(({ effectKey }) => providerEffectCount(effectKey)),
          ),
        ).toEqual([0, 0, 1]);
        const reconciliationReceipts = await withTenantScopedWorker((client) =>
          client.query<{ completed: string; count: string }>(
            `select count(*)::text as count,
                    count(completed_at)::text as completed
               from app.inbox_receipts
              where consumer_name='preview-attempt-reconciler'
                and message_id=any($1::uuid[])`,
            [events.map((event) => event.id)],
          ),
        );
        expect(reconciliationReceipts.rows[0]).toEqual({
          completed: String(reconcilable.length),
          count: String(reconcilable.length),
        });

        for (const fixture of reconcilable) {
          const crashedJob = await queue.getJob(fixture.jobId);
          if (crashedJob === undefined)
            throw new Error('crashed preview job is missing');
          await lockRedis.del(`${queue.toKey(fixture.jobId)}:lock`);
          await crashedJob.remove();
        }

        const terminal = fixtures[3];
        if (terminal === undefined) throw new Error('terminal fixture missing');
        const beforeRedelivery = await previewState(
          terminal.delivery.accepted.previewRunId,
        );
        const beforeFacts = await previewTerminalFacts(
          terminal.delivery.accepted.previewRunId,
        );
        await lockRedis.del(`${queue.toKey(terminal.jobId)}:lock`);
        await lockRedis.sadd(queue.toKey('stalled'), terminal.jobId);
        const redeliveryStore = createDatabasePreviewAttemptRunStore(
          parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
        );
        const redeliveryRuntime = await createNodeAttemptRuntime({
          database: parseDatabaseConfig({
            connectionString: databaseUrl(workerUrl),
          }),
          heartbeatIntervalMillis: 200,
          leaseDurationSeconds: 10,
          preview: {
            invoker: {
              invoke: () => {
                throw new Error('terminal preview redelivery invoked provider');
              },
            },
            runStore: redeliveryStore,
          },
          redisUrl,
          releaseCohort: 'core',
          workerId: `preview-redelivery-${randomUUID().slice(0, 8)}`,
        });
        try {
          await redeliveryRuntime.consumer.waitUntilReady(5_000);
          await waitFor(
            () =>
              queue
                .getJob(terminal.jobId)
                .then((job) => job?.getState() ?? 'missing'),
            (state) => state === 'completed',
            75_000,
          );
        } finally {
          await redeliveryRuntime.close();
        }
        expect(await providerEffectCount(terminal.effectKey)).toBe(1);
        await expect(
          previewState(terminal.delivery.accepted.previewRunId),
        ).resolves.toEqual(beforeRedelivery);
        await expect(
          previewTerminalFacts(terminal.delivery.accepted.previewRunId),
        ).resolves.toEqual(beforeFacts);
      } finally {
        await Promise.allSettled([
          reconciliationRuntime.close(),
          dispatcher.close(),
        ]);
      }
    } finally {
      await Promise.allSettled([
        producer.close(),
        queue.close(),
        lockRedis.quit(),
      ]);
      lockRedis.disconnect();
    }
  }, 90_000);

  it('preserves durable reconciliation decisions after lease-owner SIGKILL', async () => {
    const cases = [
      {
        complete: false,
        expectedStatus: 'queued',
        markDispatched: false,
        overrides: {
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          sideEffectClass: 'unsafe' as const,
        },
      },
      {
        complete: false,
        expectedStatus: 'queued',
        markDispatched: true,
        overrides: {
          mayContactProvider: true,
          mayCauseExternalSideEffect: false,
          sideEffectClass: 'safe' as const,
        },
      },
      {
        complete: false,
        expectedStatus: 'queued',
        markDispatched: true,
        overrides: {
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          providerIdempotencyKey: `preview-sigkill-${randomUUID()}`,
          sideEffectClass: 'idempotent_with_key' as const,
        },
      },
      {
        complete: false,
        expectedStatus: 'outcome_unknown',
        markDispatched: true,
        overrides: {
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          sideEffectClass: 'unsafe' as const,
        },
      },
      {
        complete: true,
        expectedStatus: 'failed',
        markDispatched: false,
        overrides: {
          mayCauseExternalSideEffect: false,
          sideEffectClass: 'safe' as const,
        },
      },
    ] as const;
    const fixtures = await Promise.all(
      cases.map(async (selected, index) => {
        const traceparent = validTraceparent(index + 10);
        const accepted = await withTenantAccept(
          acceptanceInput(traceparent, selected.overrides),
        );
        const payload = {
          schemaVersion: 1 as const,
          workspaceId,
          outboxEventId: accepted.outboxEventId,
          previewRunId: accepted.previewRunId,
          previewAttemptId: accepted.previewAttemptId,
          traceparent,
        };
        const workerId = `preview-sigkill-${String(index)}-${randomUUID().slice(0, 8)}`;
        const child = spawnPreviewCrashChild({
          complete: selected.complete,
          delivery: {
            outboxEventId: accepted.outboxEventId,
            payloadChecksum: canonicalOutboxPayloadChecksum(payload),
          },
          leaseDurationSeconds: 1,
          markDispatched: selected.markDispatched,
          previewAttemptId: accepted.previewAttemptId,
          previewRunId: accepted.previewRunId,
          workerId,
          workerUrl: databaseUrl(workerUrl),
          workspaceId,
        });
        const evidence = await child.evidence;
        return { accepted, child, evidence, selected };
      }),
    );
    const signals = await Promise.all(
      fixtures.map(async ({ child }) => child.kill()),
    );
    expect(signals).toEqual(cases.map(() => 'SIGKILL'));
    expect(fixtures.map(({ evidence }) => evidence.injectionPoint)).toEqual([
      'preview.claim_committed_before_process_exit',
      'preview.dispatch_marker_committed_before_process_exit',
      'preview.dispatch_marker_committed_before_process_exit',
      'preview.dispatch_marker_committed_before_process_exit',
      'preview.outcome_committed_before_process_exit',
    ]);

    const reconciliationRuntime = await createPreviewMaintenanceRuntime({
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      redisUrl,
    });
    const dispatcher = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        ownerRole: 'pertexo_owner',
      }),
    );
    const producer = createQueueProducer({ redisUrl });
    try {
      await Promise.all([
        reconciliationRuntime.consumer.waitUntilReady(5_000),
        dispatcher.checkReadiness(),
        producer.waitUntilReady(5_000),
      ]);
      const targetRunIds = new Set(
        fixtures.map(({ accepted }) => accepted.previewRunId),
      );
      const claimedEvents = new Map<
        string,
        Awaited<ReturnType<typeof dispatcher.claimBatch>>['events'][number]
      >();
      const events = await waitFor(
        async () => {
          const batch = await dispatcher.claimBatch({
            enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
            leaseDurationMillis: 5_000,
            leaseOwner: 'preview-sigkill-integration',
            leaseToken: randomUUID(),
            limit: 20,
            maxAttempts: 3,
          });
          for (const event of batch.events) {
            if (targetRunIds.has(event.aggregateId))
              claimedEvents.set(event.id, event);
          }
          return [...claimedEvents.values()];
        },
        (value) => value.length === cases.length,
      );
      await Promise.all(
        events.map(async (event) => {
          await producer.publish(
            parseQueueJob({ name: event.jobName, data: event.payload }),
          );
          await dispatcher.markPublished(event.id, event.leaseToken);
        }),
      );
      const states = await waitFor(
        () =>
          Promise.all(
            fixtures.map(({ accepted }) => previewState(accepted.previewRunId)),
          ),
        (values) =>
          values.every(
            (value, index) =>
              value?.run_status === cases[index]?.expectedStatus,
          ),
      );
      expect(states.map((state) => state?.run_status)).toEqual(
        cases.map(({ expectedStatus }) => expectedStatus),
      );
      expect(states.map((state) => Number(state?.attempt_fence))).toEqual([
        2, 2, 2, 2, 1,
      ]);
      const keyed = fixtures[2];
      expect(keyed?.evidence.providerIdempotencyKey).toBe(
        cases[2].overrides.providerIdempotencyKey,
      );
      const pinnedKey = await withTenantScopedWorker((client) =>
        client.query<{ provider_idempotency_key: string | null }>(
          `select provider_idempotency_key from app.preview_attempts
           where workspace_id=$1 and id=$2`,
          [workspaceId, keyed?.accepted.previewAttemptId],
        ),
      );
      expect(pinnedKey.rows[0]?.provider_idempotency_key).toBe(
        cases[2].overrides.providerIdempotencyKey,
      );
      const receipts = await withTenantScopedWorker((client) =>
        client.query<{ completed: string; count: string }>(
          `select count(*)::text as count,
                  count(completed_at)::text as completed
           from app.inbox_receipts
           where consumer_name='preview-attempt-reconciler'
             and message_id=any($1::uuid[])`,
          [events.map((event) => event.id)],
        ),
      );
      expect(receipts.rows[0]).toEqual({
        completed: String(cases.length),
        count: String(cases.length),
      });
    } finally {
      await Promise.allSettled([
        reconciliationRuntime.close(),
        dispatcher.close(),
        producer.close(),
      ]);
    }
  });
});

function deliveryJobData(delivery: AcceptedDelivery) {
  return delivery.job.data;
}

function validTraceparent(sequence: number): string {
  void sequence;
  return '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(15) + '0-01';
}
