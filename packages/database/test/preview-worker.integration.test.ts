import { createHash, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  type AcceptPreviewRunInput,
  type PreviewAttemptLease,
  type PreviewDelivery,
} from '../src/preview-execution.js';
import { canonicalOutboxPayloadChecksum } from '../src/outbox.js';
import { migrateDatabase } from '../src/migrations.js';
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

describe('worker-side preview execution seam', () => {
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
  });

  it('makes exact redelivery after a terminal outcome an inbox duplicate', async () => {
    const fixture = await acceptFixture();
    const claimed = await claimFixture(fixture, 'worker-preview-b');
    const committed = await completePreviewAttempt(workerPool, {
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
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(replayCompletion.kind).toBe('duplicate');
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

  it('reconciles an expired attempt truthfully by dispatch evidence', async () => {
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
    ).resolves.toEqual({ status: PREVIEW_STATUS.failed });

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

    const runs = await scopedQuery<{
      id: string;
      status: string;
      safe_error_code: string | null;
      output_ref: unknown;
    }>(
      `select id,status,safe_error_code,output_ref from app.preview_runs
       where workspace_id=$1 and id=any($2::uuid[]) order by id`,
      [
        workspaceId,
        [
          beforeDispatch.fixture.previewRunId,
          afterDispatch.fixture.previewRunId,
        ],
      ],
    );
    const statusById = new Map(runs.rows.map((row) => [row.id, row.status]));
    expect(statusById.get(beforeDispatch.fixture.previewRunId)).toBe(
      PREVIEW_STATUS.failed,
    );
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
