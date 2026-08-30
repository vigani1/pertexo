import { createHash, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import {
  acceptPreviewRun,
  claimPreviewDelivery,
  type AcceptPreviewRunInput,
  type PreviewAttemptLease,
  type PreviewDelivery,
} from '../../src/preview-execution.js';
import { canonicalOutboxPayloadChecksum } from '../../src/outbox.js';
import { migrateDatabase } from '../../src/migrations.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from '../phase3-compatibility-fixture.js';
import { databaseSchema } from '../../src/schema.js';
import {
  parseWorkspaceId,
  withTenantScopedClient,
} from '../../src/workspace.js';
import { dropDisconnectedDatabase } from './disposable-database.js';

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
export const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const databaseName = `pertexo_test_preview_worker_${randomUUID().replaceAll('-', '')}`;
export const workspaceId = randomUUID();
export const actorUserId = randomUUID();
export const workflowId = randomUUID();

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export const apiPool = new Pool({
  connectionString: databaseUrl(apiBaseUrl),
  max: 4,
});
export const workerPool = new Pool({
  connectionString: databaseUrl(workerBaseUrl),
  max: 4,
});
// The migration/owner role is used only for platform-row seeding and lease
// expiry injection; serving roles exercise every behavior under forced RLS.
export const ownerPool = new Pool({
  connectionString: databaseUrl(migrationBaseUrl),
  max: 1,
});

export function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === code) return true;
      current = current.cause;
    }
    return false;
  };
}

export async function withOwnerRole<T>(
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

export async function withAdmin<T>(
  work: (client: Pool) => Promise<T>,
): Promise<T> {
  const client = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    return await work(client);
  } finally {
    await client.end();
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
  const now = Date.now();
  const expiresAt = overrides.expiresAt ?? new Date(now + 60 * 60 * 1_000);
  const executionDeadlineAt =
    overrides.executionDeadlineAt ??
    new Date(Math.min(now + 5 * 60 * 1_000, expiresAt.getTime()));
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
    executionDeadlineAt,
    expiresAt,
    input: { kind: 'manual' as const, value: { hello: 'world' } },
    keyHash: createHash('sha256')
      .update(`preview-key-${String(fixtureSequence)}`)
      .digest('hex'),
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    nodeId: 'node-1',
    operation: 'preview.execute',
    operationKey: 'request',
    providerKey: 'http',
    requestId: 'preview-request-id',
    requestHash: createHash('sha256')
      .update(`preview-request-${String(fixtureSequence)}`)
      .digest('hex'),
    scope: `workflow:${workflowId}:node-1`,
    sideEffectClass: 'unsafe',
    traceparent: '00-' + 'e'.repeat(32) + '-' + 'f'.repeat(16) + '-01',
    traceId: 'preview-trace-id',
    workflowId,
    ...overrides,
  };
}

export type AcceptedFixture = Awaited<ReturnType<typeof acceptPreviewRun>> & {
  delivery: PreviewDelivery;
};

export async function acceptFixture(
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

export interface ClaimedFixture {
  kind: 'claimed';
  fixture: AcceptedFixture;
  lease: PreviewAttemptLease;
  workerId: string;
}

export interface ReconciliationFixture {
  attemptFenceToken: number;
  availableAt: Date;
  delivery: PreviewDelivery;
  outboxEventId: string;
}

export async function reconciliationFixture(
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

export async function claimFixture(
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

export async function expireLease(previewAttemptId: string): Promise<void> {
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
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher, pertexo_maintenance`,
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
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
  });
  await insertIdentity();
}, 60_000);

afterAll(async () => {
  await Promise.all([apiPool.end(), workerPool.end(), ownerPool.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

// Post-state assertions must observe rows through a tenant-scoped serving
// client: forced RLS hides everything from context-free connections.
export function scopedQuery<T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
) {
  return withTenantScopedClient(workerPool, { workspaceId }, (client) =>
    client.query<T>(sqlText, params),
  );
}

export function apiScopedQuery<T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query<T>(sqlText, params),
  );
}

export async function previewTerminalFacts(previewRunId: string) {
  const [audit, usage] = await Promise.all([
    apiScopedQuery<{
      actor_user_id: string;
      id: string;
      metadata: Record<string, unknown>;
      request_id: string | null;
      trace_id: string | null;
    }>(
      `select id,actor_user_id,request_id,trace_id,metadata
         from app.audit_events
        where workspace_id=$1 and action='preview.execution_terminal'
          and target_type='preview-run' and target_id=$2`,
      [workspaceId, previewRunId],
    ),
    apiScopedQuery<{
      category: string;
      id: string;
      idempotency_key: string;
      metadata: Record<string, unknown>;
      quantity: string;
    }>(
      `select id,category,quantity::text,idempotency_key,metadata
         from app.usage_events
        where workspace_id=$1 and resource_type='preview-run'
          and resource_id=$2`,
      [workspaceId, previewRunId],
    ),
  ]);
  return { audit: audit.rows, usage: usage.rows } as const;
}
