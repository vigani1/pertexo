import { createHash, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  acceptPreviewRun,
  claimPreviewDelivery,
  completePreviewAttempt,
  heartbeatPreviewLease,
  markPreviewDispatched,
  PREVIEW_STATUS,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  reconcileExpiredPreviewAttempt,
  reconcilePreviewDelivery,
  type AcceptPreviewRunInput,
  type PreviewAttemptLease,
  type PreviewDelivery,
} from '../src/preview-execution.js';
import {
  artifactStorageKey,
  createPendingPreviewArtifact,
} from '../src/artifacts.js';
import {
  claimPreviewCleanupDelivery,
  completePreviewArtifactDeletion,
  finishPreviewCleanupDelivery,
} from '../src/preview-cleanup.js';
import { canonicalOutboxPayloadChecksum } from '../src/outbox.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/readiness.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from './phase3-compatibility-fixture.js';
import { databaseSchema } from '../src/schema.js';
import { parseWorkspaceId, withTenantScopedClient } from '../src/workspace.js';

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

const databaseName = `pertexo_test_preview_worker_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID();
const actorUserId = randomUUID();
const workflowId = randomUUID();

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const apiPool = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 4 });
const workerPool = new Pool({
  connectionString: databaseUrl(workerBaseUrl),
  max: 4,
});
// The migration/owner role is used only for platform-row seeding and lease
// expiry injection; serving roles exercise every behavior under forced RLS.
const ownerPool = new Pool({
  connectionString: databaseUrl(migrationBaseUrl),
  max: 1,
});

function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === code) return true;
      current = current.cause;
    }
    return false;
  };
}

async function withOwnerRole<T>(
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

async function insertIdentity(): Promise<void> {
  return withOwnerRole(async (client) => {
    await client.query(
      `insert into app.users (id, email, display_name, status)
     values ($1, $2, $3, 'active')`,
      [actorUserId, 'preview-worker@example.test', 'Preview Worker'],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
     values ($1, $2, $3, 'active', $4)`,
      [
        workspaceId,
        'Preview Worker',
        `preview-worker-${randomUUID().slice(0, 8)}`,
        actorUserId,
      ],
    );
    // Forced RLS applies to the table owner too, so every tenant-scoped
    // insert below requires explicit transaction-local tenant context.
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workflows (id, workspace_id, name, lifecycle_status,
       activation_status, created_by)
     values ($1, $2, $3, 'active', 'inactive', $4)`,
      [workflowId, workspaceId, 'Preview worker target', actorUserId],
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
    await client.query(
      `insert into app.workspace_memberships
       (workspace_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')`,
      [workspaceId, actorUserId],
    );
  });
}

let fixtureSequence = 0;

function acceptanceInput(
  overrides: Partial<AcceptPreviewRunInput> = {},
): AcceptPreviewRunInput {
  fixtureSequence += 1;
  return {
    actorUserId,
    compatibilityReleaseEpoch: PHASE3_COMPATIBILITY_EXPECTATION.epoch,
    compatibilityReleaseFingerprint:
      PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
    definitionKey: 'http.request',
    definitionVersion: 1,
    draftFingerprint: 'b'.repeat(64),
    draftRevision: 3,
    dryRun: 'not_supported',
    executableNode: { id: 'node-1', type: 'http.request' },
    executorKey: 'http.request',
    executorVersion: 2,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    input: { kind: 'manual' as const, value: { hello: 'world' } },
    keyHash: createHash('sha256')
      .update(`preview-key-${String(fixtureSequence)}`)
      .digest('hex'),
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    nodeId: 'node-1',
    operation: 'preview.execute',
    requestHash: createHash('sha256')
      .update(`preview-request-${String(fixtureSequence)}`)
      .digest('hex'),
    scope: `workflow:${workflowId}:node-1`,
    sideEffectClass: 'unsafe',
    traceparent: '00-' + 'e'.repeat(32) + '-' + 'f'.repeat(16) + '-01',
    workflowId,
    ...overrides,
  };
}

type AcceptedFixture = Awaited<ReturnType<typeof acceptPreviewRun>> & {
  delivery: PreviewDelivery;
};

async function acceptFixture(
  overrides: Partial<AcceptPreviewRunInput> = {},
): Promise<AcceptedFixture> {
  const input = acceptanceInput(overrides);
  const accepted = await withTenantScopedClient(
    apiPool,
    { workspaceId },
    (client) =>
      acceptPreviewRun(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        input,
      ),
  );
  // The transport payload mirrors acceptance exactly, including optional
  // trace context; the checksum must cover those same bytes.
  const payload = {
    schemaVersion: 1,
    workspaceId,
    outboxEventId: accepted.outboxEventId,
    previewRunId: accepted.previewRunId,
    previewAttemptId: accepted.previewAttemptId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  return Object.freeze({
    ...accepted,
    delivery: {
      outboxEventId: accepted.outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    },
  });
}

interface ClaimedFixture {
  kind: 'claimed';
  fixture: AcceptedFixture;
  lease: PreviewAttemptLease;
  workerId: string;
}

interface ReconciliationFixture {
  attemptFenceToken: number;
  availableAt: Date;
  delivery: PreviewDelivery;
  outboxEventId: string;
}

async function reconciliationFixture(
  claimed: ClaimedFixture,
): Promise<ReconciliationFixture> {
  const result = await scopedQuery<{
    available_at: Date;
    id: string;
    payload: unknown;
    payload_checksum: string;
  }>(
    `select id,payload,payload_checksum,available_at
     from app.outbox_events
     where workspace_id=$1 and aggregate_id=$2
       and job_name='reconcile-preview-attempt'
       and (payload->>'attemptFenceToken')::bigint=$3
     order by created_at desc,id desc
     limit 1`,
    [
      workspaceId,
      claimed.fixture.previewRunId,
      claimed.lease.attemptFenceToken,
    ],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    typeof row.payload !== 'object' ||
    row.payload === null
  )
    throw new Error('preview reconciliation outbox missing');
  const payload = row.payload as Record<string, unknown>;
  if (payload.attemptFenceToken !== claimed.lease.attemptFenceToken)
    throw new Error('preview reconciliation fence mismatch');
  return {
    attemptFenceToken: claimed.lease.attemptFenceToken,
    availableAt: row.available_at,
    delivery: {
      outboxEventId: row.id,
      payloadChecksum: row.payload_checksum,
    },
    outboxEventId: row.id,
  };
}

async function claimFixture(
  fixture: AcceptedFixture,
  workerId: string,
  leaseDurationSeconds = 30,
): Promise<ClaimedFixture> {
  const claimed = await claimPreviewDelivery(workerPool, {
    delivery: fixture.delivery,
    leaseDurationSeconds,
    previewAttemptId: fixture.previewAttemptId,
    previewRunId: fixture.previewRunId,
    workerId,
    workspaceId,
  });
  if (claimed.kind !== 'claimed') throw new Error('expected a live claim');
  return {
    kind: 'claimed',
    fixture,
    lease: claimed.lease,
    workerId,
  };
}

async function expireLease(previewAttemptId: string): Promise<void> {
  // The worker role owns lease lifecycle columns (migration 0022), so time
  // travel for a crash proof goes through a scoped serving client.
  const result = await withTenantScopedClient(
    workerPool,
    { workspaceId },
    async (client) =>
      client.query(
        `update app.preview_attempts
         set lease_expires_at=clock_timestamp() - interval '1 second'
         where workspace_id=$1 and id=$2
         returning id`,
        [workspaceId, previewAttemptId],
      ),
  );
  if (result.rowCount !== 1) throw new Error('lease expiry injection lost');
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
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    apiRuntimeRole: 'pertexo_api',
    workerRuntimeRole: 'pertexo_worker',
    dispatcherRole: 'pertexo_dispatcher',
  });
  await insertIdentity();
}, 60_000);

afterAll(async () => {
  await Promise.all([apiPool.end(), workerPool.end(), ownerPool.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

// Post-state assertions must observe rows through a tenant-scoped serving
// client: forced RLS hides everything from context-free connections.
function scopedQuery<T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
) {
  return withTenantScopedClient(workerPool, { workspaceId }, (client) =>
    client.query<T>(sqlText, params),
  );
}

function apiScopedQuery<T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query<T>(sqlText, params),
  );
}

async function previewTerminalFacts(previewRunId: string) {
  const [audit, usage] = await Promise.all([
    apiScopedQuery<{
      actor_user_id: string;
      metadata: Record<string, unknown>;
      trace_id: string | null;
    }>(
      `select actor_user_id,trace_id,metadata
         from app.audit_events
        where workspace_id=$1 and action='preview.execution_terminal'
          and target_type='preview-run' and target_id=$2`,
      [workspaceId, previewRunId],
    ),
    apiScopedQuery<{
      category: string;
      idempotency_key: string;
      metadata: Record<string, unknown>;
      quantity: string;
    }>(
      `select category,quantity::text,idempotency_key,metadata
         from app.usage_events
        where workspace_id=$1 and resource_type='preview-run'
          and resource_id=$2`,
      [workspaceId, previewRunId],
    ),
  ]);
  return { audit: audit.rows, usage: usage.rows } as const;
}

describe('worker-side preview execution seam', () => {
  it('reports the preview artifact ownership migration and least-privilege grants ready', async () => {
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ migrationHead: EXPECTED_MIGRATION_HEAD });
    await expect(
      checkDatabaseReadiness(workerPool, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ migrationHead: EXPECTED_MIGRATION_HEAD });
  });

  it('binds preview artifacts to their owner and enforces inherited retention', async () => {
    const previewDeadline = new Date(Date.now() + 15 * 60_000);
    const accepted = await acceptFixture({ expiresAt: previewDeadline });
    const artifactId = randomUUID();
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      createPendingPreviewArtifact(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        {
          artifactId,
          byteLength: 3,
          expiresAt: previewDeadline,
          mediaType: 'application/octet-stream',
          previewRunId: accepted.previewRunId,
          purpose: 'node-output',
          sha256: 'a'.repeat(64),
          storageKey: artifactStorageKey(workspaceId, artifactId),
        },
      ),
    );
    const linked = await scopedQuery<{
      artifact_expires_at: Date;
      owner_id: string;
      owner_kind: string;
      preview_expires_at: Date;
    }>(
      `select artifact.expires_at as artifact_expires_at,
              link.owner_id,link.owner_kind,
              preview.expires_at as preview_expires_at
       from app.artifact_links link
       join app.artifacts artifact
         on artifact.workspace_id=link.workspace_id
        and artifact.id=link.artifact_id
       join app.preview_runs preview
         on preview.workspace_id=link.workspace_id
        and preview.id=link.owner_id
       where link.workspace_id=$1 and link.artifact_id=$2`,
      [workspaceId, artifactId],
    );
    expect(linked.rows[0]).toMatchObject({
      owner_id: accepted.previewRunId,
      owner_kind: 'preview_run',
    });
    expect(linked.rows[0]?.artifact_expires_at.getTime()).toBe(
      linked.rows[0]?.preview_expires_at.getTime(),
    );

    const overRetainedArtifactId = randomUUID();
    await expect(
      withTenantScopedClient(workerPool, { workspaceId }, (client) =>
        createPendingPreviewArtifact(
          {
            db: drizzle(client, { schema: databaseSchema }),
            workspaceId: parseWorkspaceId(workspaceId),
          },
          {
            artifactId: overRetainedArtifactId,
            byteLength: 3,
            expiresAt: new Date(previewDeadline.getTime() + 1),
            mediaType: 'application/octet-stream',
            previewRunId: accepted.previewRunId,
            purpose: 'node-output',
            sha256: 'b'.repeat(64),
            storageKey: artifactStorageKey(workspaceId, overRetainedArtifactId),
          },
        ),
      ),
    ).rejects.toSatisfy(expectPgCode('23514'));
    const rolledBack = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.artifacts
       where workspace_id=$1 and id=$2`,
      [workspaceId, overRetainedArtifactId],
    );
    expect(rolledBack.rows[0]).toEqual({ count: '0' });
  });

  it('does not quarantine an artifact while its preview attempt is nonterminal', async () => {
    const previewDeadline = new Date(Date.now() + 200);
    const accepted = await acceptFixture({ expiresAt: previewDeadline });
    const artifactId = randomUUID();
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      createPendingPreviewArtifact(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        {
          artifactId,
          byteLength: 3,
          expiresAt: previewDeadline,
          mediaType: 'application/octet-stream',
          previewRunId: accepted.previewRunId,
          purpose: 'node-output',
          sha256: '7'.repeat(64),
          storageKey: artifactStorageKey(workspaceId, artifactId),
        },
      ),
    );
    const cleanup = await scopedQuery<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
       where workspace_id=$1 and aggregate_id=$2
         and job_name='sweep-expired-previews'`,
      [workspaceId, accepted.previewRunId],
    );
    const cleanupRow = cleanup.rows[0];
    if (cleanupRow === undefined)
      throw new Error('preview cleanup outbox missing');
    await ownerPool.query('select pg_sleep(0.25)');
    const directCleanup = await withTenantScopedClient(
      workerPool,
      { workspaceId },
      (client) =>
        client.query<{ completed: boolean }>(
          `select app.complete_preview_cleanup($1,$2) as completed`,
          [workspaceId, accepted.previewRunId],
        ),
    );
    expect(directCleanup.rows[0]).toEqual({ completed: false });
    await expect(
      claimPreviewCleanupDelivery(workerPool, {
        artifactLimit: 10,
        artifactQuiescenceSeconds: 1,
        delivery: {
          outboxEventId: cleanupRow.id,
          payloadChecksum: cleanupRow.payload_checksum,
        },
        previewRunId: accepted.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ kind: 'rescheduled' });
    const state = await scopedQuery<{ status: string }>(
      `select status from app.artifacts
       where workspace_id=$1 and id=$2`,
      [workspaceId, artifactId],
    );
    expect(state.rows[0]).toEqual({ status: 'pending' });
  });

  it('deletes expired preview rows and owned artifact metadata through the authorized function', async () => {
    const previewDeadline = new Date(Date.now() + 250);
    const reusableKeyHash = '9'.repeat(64);
    const accepted = await acceptFixture({
      expiresAt: previewDeadline,
      keyHash: reusableKeyHash,
    });
    const claimedPreview = await claimFixture(
      accepted,
      'worker-preview-cleanup-terminal',
    );
    await completePreviewAttempt(workerPool, {
      delivery: accepted.delivery,
      lease: claimedPreview.lease,
      outcome: {
        safeErrorCode: 'preview.cleanup_fixture',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimedPreview.workerId,
    });
    const cleanup = await scopedQuery<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
       where workspace_id=$1 and aggregate_id=$2
         and job_name='sweep-expired-previews'`,
      [workspaceId, accepted.previewRunId],
    );
    const cleanupRow = cleanup.rows[0];
    if (cleanupRow === undefined)
      throw new Error('preview cleanup outbox missing');
    const artifactIds = [randomUUID(), randomUUID()].toSorted();
    await withTenantScopedClient(
      workerPool,
      { workspaceId },
      async (client) => {
        for (const [index, artifactId] of artifactIds.entries()) {
          await createPendingPreviewArtifact(
            {
              db: drizzle(client, { schema: databaseSchema }),
              workspaceId: parseWorkspaceId(workspaceId),
            },
            {
              artifactId,
              byteLength: 3,
              expiresAt: previewDeadline,
              mediaType: 'application/octet-stream',
              previewRunId: accepted.previewRunId,
              purpose: 'node-output',
              sha256: (index === 0 ? 'c' : 'd').repeat(64),
              storageKey: artifactStorageKey(workspaceId, artifactId),
            },
          );
        }
      },
    );
    const firstArtifactId = artifactIds[0];
    const secondArtifactId = artifactIds[1];
    if (firstArtifactId === undefined || secondArtifactId === undefined)
      throw new Error('preview cleanup artifact fixtures missing');
    await ownerPool.query('select pg_sleep(0.3)');
    const initialDelivery = {
      outboxEventId: cleanupRow.id,
      payloadChecksum: cleanupRow.payload_checksum,
    };
    const quarantined = await claimPreviewCleanupDelivery(workerPool, {
      artifactLimit: 10,
      artifactQuiescenceSeconds: 1,
      delivery: initialDelivery,
      previewRunId: accepted.previewRunId,
      workspaceId,
    });
    expect(quarantined).toMatchObject({ kind: 'rescheduled' });
    if (quarantined.kind !== 'rescheduled')
      throw new Error('preview cleanup quarantine missing');
    const quarantineSuccessor = await scopedQuery<{
      payload_checksum: string;
    }>(
      `select payload_checksum from app.outbox_events
       where workspace_id=$1 and id=$2`,
      [workspaceId, quarantined.cleanupOutboxEventId],
    );
    const quarantineChecksum = quarantineSuccessor.rows[0]?.payload_checksum;
    if (quarantineChecksum === undefined)
      throw new Error('preview cleanup quarantine checksum missing');
    await ownerPool.query('select pg_sleep(1.1)');
    const delivery = {
      outboxEventId: quarantined.cleanupOutboxEventId,
      payloadChecksum: quarantineChecksum,
    };
    await expect(
      claimPreviewCleanupDelivery(workerPool, {
        artifactLimit: 1,
        artifactQuiescenceSeconds: 1,
        delivery,
        previewRunId: accepted.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({
      kind: 'claimed',
      artifacts: [{ artifactId: firstArtifactId, workspaceId }],
    });
    await completePreviewArtifactDeletion(workerPool, {
      artifactId: firstArtifactId,
      previewRunId: accepted.previewRunId,
      workspaceId,
    });
    const continued = await finishPreviewCleanupDelivery(workerPool, {
      artifactQuiescenceSeconds: 1,
      delivery,
      previewRunId: accepted.previewRunId,
      workspaceId,
    });
    expect(continued).toMatchObject({ kind: 'continued' });
    if (
      continued.kind !== 'continued' ||
      continued.cleanupOutboxEventId === undefined
    )
      throw new Error('preview cleanup continuation missing');
    const successor = await scopedQuery<{ payload_checksum: string }>(
      `select payload_checksum from app.outbox_events
       where workspace_id=$1 and id=$2`,
      [workspaceId, continued.cleanupOutboxEventId],
    );
    const successorChecksum = successor.rows[0]?.payload_checksum;
    if (successorChecksum === undefined)
      throw new Error('preview cleanup continuation checksum missing');
    const successorDelivery = {
      outboxEventId: continued.cleanupOutboxEventId,
      payloadChecksum: successorChecksum,
    };
    await expect(
      claimPreviewCleanupDelivery(workerPool, {
        artifactLimit: 1,
        artifactQuiescenceSeconds: 1,
        delivery: successorDelivery,
        previewRunId: accepted.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({
      kind: 'claimed',
      artifacts: [{ artifactId: secondArtifactId, workspaceId }],
    });
    await completePreviewArtifactDeletion(workerPool, {
      artifactId: secondArtifactId,
      previewRunId: accepted.previewRunId,
      workspaceId,
    });
    await expect(
      finishPreviewCleanupDelivery(workerPool, {
        artifactQuiescenceSeconds: 1,
        delivery: successorDelivery,
        previewRunId: accepted.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'completed' });

    const removed = await scopedQuery<{
      artifacts: string;
      attempts: string;
      idempotency: string;
      links: string;
      runs: string;
    }>(
      `select
         (select count(*)::text from app.preview_runs
           where workspace_id=$1 and id=$2) as runs,
         (select count(*)::text from app.preview_attempts
           where workspace_id=$1 and preview_run_id=$2) as attempts,
         (select count(*)::text from app.idempotency_records
           where workspace_id=$1 and resource_id=$2) as idempotency,
         (select count(*)::text from app.artifact_links
           where workspace_id=$1 and owner_id=$2) as links,
         (select count(*)::text from app.artifacts
           where workspace_id=$1 and id=any($3::uuid[])) as artifacts`,
      [workspaceId, accepted.previewRunId, artifactIds],
    );
    expect(removed.rows[0]).toEqual({
      artifacts: '0',
      attempts: '0',
      idempotency: '0',
      links: '0',
      runs: '0',
    });
    await expect(
      claimPreviewCleanupDelivery(workerPool, {
        artifactLimit: 10,
        artifactQuiescenceSeconds: 1,
        delivery: initialDelivery,
        previewRunId: accepted.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      acceptFixture({
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        keyHash: reusableKeyHash,
        requestHash: '8'.repeat(64),
      }),
    ).resolves.toMatchObject({ duplicate: false });
  });

  it('claims a queued attempt with pinned identity and completes truthfully', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-a',
    );
    expect(claimed.lease).toMatchObject({
      attemptFenceToken: 1,
      definitionKey: 'http.request',
      definitionVersion: 1,
      dryRun: 'not_supported',
      executorKey: 'http.request',
      executorVersion: 2,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      nodeId: 'node-1',
      sideEffectClass: 'unsafe',
      workspaceId,
      workflowId,
    });
    expect(claimed.lease.input).toMatchObject({ kind: 'inline' });
    expect(claimed.lease.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u,
    );
    expect(claimed.lease.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const attemptState = await scopedQuery<{
      status: string;
      started_at: Date | null;
    }>(
      `select status,started_at from app.preview_attempts
       where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewAttemptId],
    );
    expect(attemptState.rows[0]).toMatchObject({ status: 'running' });
    expect(attemptState.rows[0]?.started_at).not.toBeNull();

    const completed = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        output: {
          schemaVersion: 1,
          kind: 'inline',
          value: { done: true },
        },
        status: PREVIEW_STATUS.succeeded,
      },
      workerId: claimed.workerId,
    });
    expect(completed.kind).toBe('committed');

    const runState = await scopedQuery<{
      status: string;
      output_ref: unknown;
      safe_error_code: string | null;
      completed_at: Date | null;
    }>(
      `select status,output_ref,safe_error_code,completed_at
       from app.preview_runs where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewRunId],
    );
    expect(runState.rows[0]).toMatchObject({
      safe_error_code: null,
      status: 'succeeded',
    });
    expect(runState.rows[0]?.output_ref).not.toBeNull();
    expect(runState.rows[0]?.completed_at).not.toBeNull();

    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(facts.audit).toEqual([
      {
        actor_user_id: actorUserId,
        metadata: {
          schemaVersion: 1,
          status: PREVIEW_STATUS.succeeded,
          workflowId,
          nodeId: 'node-1',
          definitionKey: 'http.request',
          definitionVersion: 1,
          executorKey: 'http.request',
          executorVersion: 2,
          sideEffectClass: 'unsafe',
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          previewAttemptId: claimed.fixture.previewAttemptId,
        },
        trace_id: 'e'.repeat(32),
      },
    ]);
    expect(facts.usage).toEqual([
      {
        category: 'preview_execution',
        idempotency_key: `preview-terminal:${claimed.fixture.previewRunId}`,
        metadata: {
          schemaVersion: 1,
          status: PREVIEW_STATUS.succeeded,
          definitionKey: 'http.request',
          executorKey: 'http.request',
          sideEffectClass: 'unsafe',
        },
        quantity: '1',
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain('hello');
    expect(JSON.stringify(facts)).not.toContain('done');
  });

  it('makes exact redelivery after a terminal outcome an inbox duplicate', async () => {
    const fixture = await acceptFixture();
    const claimed = await claimFixture(fixture, 'worker-preview-b');
    const committed = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(committed.kind).toBe('committed');

    const redelivered = await claimPreviewDelivery(workerPool, {
      delivery: fixture.delivery,
      leaseDurationSeconds: 30,
      previewAttemptId: fixture.previewAttemptId,
      previewRunId: fixture.previewRunId,
      workerId: 'worker-preview-c',
      workspaceId,
    });
    expect(redelivered).toEqual({ kind: 'duplicate' });

    // Completing again is an idempotent duplicate, not a second effect.
    const replayCompletion = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(replayCompletion.kind).toBe('duplicate');
    const facts = await previewTerminalFacts(fixture.previewRunId);
    expect(facts.audit).toHaveLength(1);
    expect(facts.usage).toHaveLength(1);
  });

  it('rolls the terminal transition back when its facts cannot commit', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-terminal-fact-atomicity',
    );
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      client.query(
        `insert into app.usage_events (
           id,workspace_id,category,quantity,resource_type,resource_id,
           idempotency_key,metadata
         ) values ($1,$2,'preview_execution',1,'preview-run',$3,$4,'{}')`,
        [
          randomUUID(),
          workspaceId,
          claimed.fixture.previewRunId,
          `preview-terminal:${claimed.fixture.previewRunId}`,
        ],
      ),
    );

    await expect(
      completePreviewAttempt(workerPool, {
        delivery: claimed.fixture.delivery,
        lease: claimed.lease,
        outcome: {
          safeErrorCode: 'preview.provider_rejected',
          status: PREVIEW_STATUS.failed,
        },
        workerId: claimed.workerId,
      }),
    ).rejects.toSatisfy(expectPgCode('23505'));

    const state = await scopedQuery<{ status: string }>(
      `select status from app.preview_runs
        where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewRunId],
    );
    expect(state.rows).toEqual([{ status: PREVIEW_STATUS.running }]);
    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(facts.audit).toHaveLength(0);
    expect(facts.usage).toHaveLength(1);
  });

  it('rejects a forged checksum reuse of a valid outbox row with a security fact', async () => {
    const fixture = await acceptFixture();
    const forged: PreviewDelivery = {
      outboxEventId: fixture.delivery.outboxEventId,
      payloadChecksum: 'f'.repeat(64),
    };
    await expect(
      claimPreviewDelivery(workerPool, {
        delivery: forged,
        leaseDurationSeconds: 30,
        previewAttemptId: fixture.previewAttemptId,
        previewRunId: fixture.previewRunId,
        workerId: 'worker-preview-d',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewDeliveryMismatchError);

    const facts = await scopedQuery(
      `select count(*)::text as count from app.transport_security_audit_facts
       where workspace_id=$1 and message_id=$2`,
      [workspaceId, fixture.delivery.outboxEventId],
    );
    expect(facts.rows[0]).toEqual({ count: '1' });
  });

  it('fences stale workers and heartbeats only the current owner', async () => {
    const first = await claimFixture(
      await acceptFixture(),
      'worker-preview-e',
      5,
    );
    await expireLease(first.fixture.previewAttemptId);
    const second = await claimFixture(first.fixture, 'worker-preview-f');
    expect(second.lease.attemptFenceToken).toBe(
      first.lease.attemptFenceToken + 1,
    );

    await expect(
      markPreviewDispatched(workerPool, {
        lease: first.lease,
        workerId: first.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    await expect(
      heartbeatPreviewLease(workerPool, {
        lease: first.lease,
        leaseDurationSeconds: 30,
        workerId: first.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: first.fixture.delivery,
        lease: first.lease,
        outcome: {
          output: { schemaVersion: 1, kind: 'inline', value: 'stale' },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: first.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);

    const beat = await heartbeatPreviewLease(workerPool, {
      lease: second.lease,
      leaseDurationSeconds: 45,
      workerId: second.workerId,
    });
    expect(beat.attemptLeaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(beat.runExpiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        workerId: second.workerId,
      }),
    ).resolves.toBe('committed');
  });

  it('reconciles expired attempts by dispatch evidence and side-effect class', async () => {
    const beforeDispatch = await claimFixture(
      await acceptFixture(),
      'worker-preview-g',
      5,
    );
    await expireLease(beforeDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: beforeDispatch.fixture.previewAttemptId,
        previewRunId: beforeDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'reconciliation_reclaim_required' });
    const reclaimedBeforeDispatch = await claimFixture(
      beforeDispatch.fixture,
      'worker-preview-g2',
    );
    expect(reclaimedBeforeDispatch.lease.attemptFenceToken).toBe(
      beforeDispatch.lease.attemptFenceToken + 1,
    );

    const afterDispatch = await claimFixture(
      await acceptFixture(),
      'worker-preview-h',
      5,
    );
    await markPreviewDispatched(workerPool, {
      lease: afterDispatch.lease,
      workerId: afterDispatch.workerId,
    });
    await expireLease(afterDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: afterDispatch.fixture.previewAttemptId,
        previewRunId: afterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ status: PREVIEW_STATUS.outcomeUnknown });

    const safeAfterDispatch = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-safe',
      5,
    );
    await markPreviewDispatched(workerPool, {
      lease: safeAfterDispatch.lease,
      workerId: safeAfterDispatch.workerId,
    });
    await expireLease(safeAfterDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: safeAfterDispatch.fixture.previewAttemptId,
        previewRunId: safeAfterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'reconciliation_reclaim_required' });
    const reclaimedSafe = await claimFixture(
      safeAfterDispatch.fixture,
      'worker-preview-safe2',
    );
    expect(reclaimedSafe.lease.attemptFenceToken).toBe(
      safeAfterDispatch.lease.attemptFenceToken + 1,
    );

    const idempotentAfterDispatch = await claimFixture(
      await acceptFixture({
        providerIdempotencyKey: `preview-key-${randomUUID()}`,
        sideEffectClass: 'idempotent_with_key',
      }),
      'worker-preview-keyed',
      5,
    );
    await markPreviewDispatched(workerPool, {
      lease: idempotentAfterDispatch.lease,
      workerId: idempotentAfterDispatch.workerId,
    });
    await expireLease(idempotentAfterDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: idempotentAfterDispatch.fixture.previewAttemptId,
        previewRunId: idempotentAfterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'reconciliation_reclaim_required' });
    const reclaimedIdempotent = await claimFixture(
      idempotentAfterDispatch.fixture,
      'worker-preview-keyed2',
    );
    expect(reclaimedIdempotent.lease.providerIdempotencyKey).toBe(
      idempotentAfterDispatch.lease.providerIdempotencyKey,
    );

    const runs = await scopedQuery<{
      id: string;
      status: string;
      safe_error_code: string | null;
      output_ref: unknown;
    }>(
      `select id,status,safe_error_code,output_ref from app.preview_runs
       where workspace_id=$1 and id=any($2::uuid[]) order by id`,
      [workspaceId, [afterDispatch.fixture.previewRunId]],
    );
    const statusById = new Map(runs.rows.map((row) => [row.id, row.status]));
    expect(statusById.get(afterDispatch.fixture.previewRunId)).toBe(
      PREVIEW_STATUS.outcomeUnknown,
    );
    for (const row of runs.rows) expect(row.output_ref).toBeNull();

    // A live lease blocks reconciliation, and once terminal it is idempotent.
    const live = await claimFixture(await acceptFixture(), 'worker-preview-i');
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: live.fixture.previewAttemptId,
        previewRunId: live.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    await expireLease(live.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: afterDispatch.fixture.previewAttemptId,
        previewRunId: afterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ status: PREVIEW_STATUS.outcomeUnknown });
  });

  it('durably schedules, reschedules, and deduplicates lease reconciliation', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-live',
      5,
    );
    const initial = await reconciliationFixture(claimed);
    expect(initial.availableAt.getTime()).toBeGreaterThan(Date.now());

    const heartbeat = await heartbeatPreviewLease(workerPool, {
      lease: claimed.lease,
      leaseDurationSeconds: 30,
      workerId: claimed.workerId,
    });
    const rescheduled = await reconcilePreviewDelivery(workerPool, {
      attemptFenceToken: initial.attemptFenceToken,
      delivery: initial.delivery,
      previewAttemptId: claimed.fixture.previewAttemptId,
      previewRunId: claimed.fixture.previewRunId,
      workspaceId,
    });
    expect(rescheduled).toMatchObject({ kind: 'rescheduled' });
    const successorId =
      rescheduled.kind === 'rescheduled'
        ? rescheduled.reconciliationOutboxEventId
        : undefined;
    expect(successorId).toBeDefined();
    const successor = await scopedQuery<{
      available_at: Date;
      job_name: string;
    }>(
      `select available_at,job_name from app.outbox_events
       where workspace_id=$1 and id=$2`,
      [workspaceId, successorId],
    );
    expect(successor.rows[0]).toMatchObject({
      job_name: 'reconcile-preview-attempt',
    });
    expect(successor.rows[0]?.available_at.getTime()).toBe(
      heartbeat.attemptLeaseExpiresAt.getTime(),
    );

    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: initial.attemptFenceToken,
        delivery: initial.delivery,
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    const successorCount = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.outbox_events
       where workspace_id=$1 and id=$2`,
      [workspaceId, successorId],
    );
    expect(successorCount.rows[0]).toEqual({ count: '1' });
  });

  it('fences and redelivers expired reclaimable work through a new outbox event', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-safe',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: claimed.workerId,
    });
    await expireLease(claimed.fixture.previewAttemptId);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    const redelivered = await reconcilePreviewDelivery(workerPool, {
      attemptFenceToken: reconciliation.attemptFenceToken,
      delivery: reconciliation.delivery,
      previewAttemptId: claimed.fixture.previewAttemptId,
      previewRunId: claimed.fixture.previewRunId,
      workspaceId,
    }).finally(() => vi.useRealTimers());
    expect(redelivered).toMatchObject({ kind: 'redelivered' });
    if (redelivered.kind !== 'redelivered')
      throw new Error('expected execution redelivery');
    const replacement = await scopedQuery<{
      available_at: Date;
      database_now: Date;
      payload: Record<string, unknown>;
      payload_checksum: string;
    }>(
      `select payload,payload_checksum,available_at,
              clock_timestamp() as database_now
       from app.outbox_events
       where workspace_id=$1 and id=$2 and job_name='execute-preview-attempt'`,
      [workspaceId, redelivered.executionOutboxEventId],
    );
    const replacementRow = replacement.rows[0];
    if (replacementRow === undefined)
      throw new Error('replacement execution outbox missing');
    expect(
      Math.abs(
        replacementRow.available_at.getTime() -
          replacementRow.database_now.getTime(),
      ),
    ).toBeLessThan(5_000);
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: claimed.fixture.delivery,
        lease: claimed.lease,
        outcome: {
          output: { schemaVersion: 1, kind: 'inline', value: 'stale' },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: claimed.workerId,
      }),
    ).rejects.toMatchObject({ code: 'completion_lost' });

    const replacementClaim = await claimPreviewDelivery(workerPool, {
      delivery: {
        outboxEventId: redelivered.executionOutboxEventId,
        payloadChecksum: replacementRow.payload_checksum,
      },
      leaseDurationSeconds: 30,
      previewAttemptId: claimed.fixture.previewAttemptId,
      previewRunId: claimed.fixture.previewRunId,
      workerId: 'worker-preview-reconcile-safe-2',
      workspaceId,
    });
    expect(replacementClaim.kind).toBe('claimed');
    if (replacementClaim.kind === 'claimed') {
      expect(replacementClaim.lease.attemptFenceToken).toBe(
        claimed.lease.attemptFenceToken + 2,
      );
    }
  });

  it('records unsafe post-dispatch ambiguity from the durable wake-up', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-reconcile-unsafe',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: claimed.workerId,
    });
    await expireLease(claimed.fixture.previewAttemptId);

    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: reconciliation.attemptFenceToken,
        delivery: reconciliation.delivery,
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({
      kind: 'completed',
      status: PREVIEW_STATUS.outcomeUnknown,
    });
    const state = await scopedQuery<{
      fence_token: string;
      reconciliation_ref: Record<string, unknown>;
      status: string;
    }>(
      `select status,fence_token,reconciliation_ref
       from app.preview_attempts where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewAttemptId],
    );
    expect(state.rows[0]).toMatchObject({
      status: PREVIEW_STATUS.outcomeUnknown,
      reconciliation_ref: {
        reason: 'lease_expired_after_unsafe_dispatch',
      },
    });
    expect(Number(state.rows[0]?.fence_token)).toBe(
      claimed.lease.attemptFenceToken + 1,
    );
    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(facts.audit).toHaveLength(1);
    expect(facts.usage).toHaveLength(1);
    expect(facts.audit[0]?.metadata).toMatchObject({
      status: PREVIEW_STATUS.outcomeUnknown,
    });
    expect(facts.usage[0]?.metadata).toMatchObject({
      status: PREVIEW_STATUS.outcomeUnknown,
    });
  });

  it('times out expired undispatched work instead of redelivering past its deadline', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        expiresAt: new Date(Date.now() + 250),
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-deadline',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expireLease(claimed.fixture.previewAttemptId);

    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: reconciliation.attemptFenceToken,
        delivery: reconciliation.delivery,
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({
      kind: 'completed',
      status: PREVIEW_STATUS.timedOut,
    });
    const replacement = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.outbox_events
       where workspace_id=$1 and aggregate_id=$2
         and job_name='execute-preview-attempt' and id<>$3`,
      [
        workspaceId,
        claimed.fixture.previewRunId,
        claimed.fixture.outboxEventId,
      ],
    );
    expect(replacement.rows[0]).toEqual({ count: '0' });
  });

  it('checksum-binds reconciliation deliveries and audits forged reuse', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-security',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: reconciliation.attemptFenceToken,
        delivery: {
          ...reconciliation.delivery,
          payloadChecksum: '0'.repeat(64),
        },
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewDeliveryMismatchError);
    const facts = await scopedQuery<{ count: string }>(
      `select count(*)::text as count
       from app.transport_security_audit_facts
       where workspace_id=$1 and message_id=$2
         and consumer_name='preview-attempt-reconciler'`,
      [workspaceId, reconciliation.outboxEventId],
    );
    expect(facts.rows[0]).toEqual({ count: '1' });
  });

  it('hides cross-workspace claims under forced RLS', async () => {
    const fixture = await acceptFixture();
    await expect(
      claimPreviewDelivery(workerPool, {
        delivery: fixture.delivery,
        leaseDurationSeconds: 30,
        previewAttemptId: fixture.previewAttemptId,
        previewRunId: fixture.previewRunId,
        workerId: 'worker-preview-j',
        workspaceId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
  });
});
