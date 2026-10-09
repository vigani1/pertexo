import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createRetentionDatabase } from '../src/lifecycle/retention.js';
import { changeWorkspaceLifecycle } from '../src/lifecycle/workspace-deletion.js';
import { withTenantScopedClient } from '../src/tenant-access/workspace.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import {
  actorId,
  apiBaseUrl,
  migrationBaseUrl,
} from './coordinator-run-store.fixtures.js';
import {
  applyHealthCommand,
  asOwner,
  asRuntime,
  claimHealthAttempt,
  createHealthConnection,
  databaseUrl,
  healthCommand,
  healthCompletion,
  markHealthDispatched,
  nodeAttemptStore,
  readHealth,
  workerBaseUrl,
  workspaceA,
} from './support/connection-run-health.fixture.js';
import { purgeWorkspace } from './support/workspace-purge.js';

const dispatcherBase =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const maintenanceBase =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const adminBase =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const api = new Pool({ connectionString: databaseUrl(apiBaseUrl), max: 1 });
const worker = new Pool({
  connectionString: databaseUrl(workerBaseUrl),
  max: 1,
});
const dispatcher = new Pool({
  connectionString: databaseUrl(dispatcherBase),
  max: 1,
});
const maintenance = new Pool({
  connectionString: databaseUrl(maintenanceBase),
  max: 1,
});

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminBase, max: 1 });
  try {
    const name = new URL(databaseUrl(migrationBaseUrl)).pathname.slice(1);
    if (!/^pertexo_test_[a-z0-9_]+$/u.test(name))
      throw new Error('Boundary test requires an isolated database');
    await admin.query(
      `grant connect on database "${name}" to pertexo_maintenance,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
}, 120_000);

afterAll(async () => {
  const outcomes = await Promise.allSettled([
    api.end(),
    worker.end(),
    dispatcher.end(),
    maintenance.end(),
  ]);
  const failures = outcomes
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason as unknown);
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Connection health boundary cleanup failed',
    );
});

async function completedEvidence() {
  const connection = await createHealthConnection();
  const lease = await claimHealthAttempt(connection);
  await markHealthDispatched(lease, connection);
  await nodeAttemptStore.complete(healthCompletion(lease));
  const command = await healthCommand(lease);
  return { connection, lease, command };
}

async function evidenceCounts(attemptId: string, outboxId: string) {
  return asOwner(workspaceA, async (client) => {
    const result = await client.query<{
      dispatches: number;
      observations: number;
      commands: number;
    }>(
      `select (select count(*)::int from app.node_attempt_connection_dispatches where workspace_id=$1 and attempt_id=$2) dispatches,
        (select count(*)::int from app.connection_health_observations where workspace_id=$1 and attempt_id=$2) observations,
        (select count(*)::int from app.outbox_events where workspace_id=$1 and id=$3) commands`,
      [workspaceA, attemptId, outboxId],
    );
    return result.rows[0];
  });
}

describe('connection health runtime boundary', () => {
  it('accepts the fresh protocol for every serving role without activating run health', async () => {
    for (const [pool, role] of [
      [api, 'pertexo_app'],
      [worker, 'pertexo_app'],
      [dispatcher, 'pertexo_maintenance'],
    ] as const)
      await expect(checkDatabaseReadiness(pool)).resolves.toMatchObject({
        role,
      });
  });

  it('allows only API and worker tenant-bound notification connection locks', async () => {
    const connection = await createHealthConnection();
    for (const pool of [api, worker]) {
      const tenant = await pool.query<{ tenant: string | null }>(
        "select nullif(current_setting('app.workspace_id',true),'') tenant",
      );
      expect(tenant.rows).toEqual([{ tenant: null }]);
      const omitted = await pool.query(
        'select * from app.lock_notification_connection($1,$2)',
        [workspaceA, connection.connectionId],
      );
      expect(omitted.rows).toEqual([]);
    }
    for (const base of [apiBaseUrl, workerBaseUrl]) {
      const allowed = await asRuntime(base, workspaceA, (client) =>
        client.query('select * from app.lock_notification_connection($1,$2)', [
          workspaceA,
          connection.connectionId,
        ]),
      );
      expect(allowed.rows).toEqual([
        {
          auth_type: 'slack_bot_token',
          current_secret_version_id: connection.secretVersionId,
          provider_key: 'slack',
          status: 'active',
        },
      ]);
      for (const tenant of ['', randomUUID()]) {
        const denied = await asRuntime(base, workspaceA, async (client) => {
          await client.query("select set_config('app.workspace_id',$1,true)", [
            tenant,
          ]);
          return client.query(
            'select * from app.lock_notification_connection($1,$2)',
            [workspaceA, connection.connectionId],
          );
        });
        expect(denied.rows).toEqual([]);
      }
      const otherWorkspace = await asRuntime(base, workspaceA, (client) =>
        client.query('select * from app.lock_notification_connection($1,$2)', [
          randomUUID(),
          connection.connectionId,
        ]),
      );
      expect(otherWorkspace.rows).toEqual([]);
    }
    await expect(
      asRuntime(dispatcherBase, workspaceA, (client) =>
        client.query('select * from app.lock_notification_connection($1,$2)', [
          workspaceA,
          connection.connectionId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('denies maintenance health writes and fences app health functions', async () => {
    await expect(
      asRuntime(dispatcherBase, workspaceA, (client) =>
        client.query(
          "select app.apply_connection_health_observation($1,$2,'enforce',$3,$4)",
          [workspaceA, randomUUID(), randomUUID(), 'a'.repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          "update app.connections set status='reauthorization_required' where workspace_id=$1",
          [workspaceA],
        ),
      ),
    ).rejects.toThrow('connection health requires revision-aware writer');
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query('insert into app.connection_events(id) values($1)', [
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          "select app.apply_connection_health_observation($1,$2,'enforce',$3,$4)",
          [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: 'PTH04' });
    const connection = await createHealthConnection();
    await expect(
      asRuntime(apiBaseUrl, workspaceA, async (client) => {
        await client.query("select set_config('app.actor_id',$1,true)", [
          actorId,
        ]);
        return client.query(
          'update app.connections set last_tested_at=clock_timestamp() where workspace_id=$1 and id=$2',
          [workspaceA, connection.connectionId],
        );
      }),
    ).rejects.toMatchObject({ code: 'PTH01' });
  });
});

describe('connection health retention and tenant purge', () => {
  it('cascades evidence with source-attempt retention, removes its command and receipts late delivery as a no-op', async () => {
    const evidence = await completedEvidence();
    const before = await readHealth(evidence.connection.connectionId);
    await asOwner(workspaceA, async (client) => {
      await client.query(
        'alter table app.workflow_runs no force row level security',
      );
      await client.query(
        "update app.workflow_runs set status='failed',input_ref=null,input_ref_expires_at=null,created_at='2026-01-01',updated_at='2026-01-02',completed_at='2026-01-02' where id=$1",
        [evidence.lease.runId],
      );
      await client.query(
        'alter table app.workflow_runs force row level security',
      );
    });
    const retention = createRetentionDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(maintenanceBase),
        max: 2,
      }),
      { pageSize: 1 },
    );
    try {
      expect(
        await evidenceCounts(
          evidence.lease.attemptId,
          evidence.command.delivery.outboxEventId,
        ),
      ).toEqual({ dispatches: 1, observations: 1, commands: 1 });
      while ((await retention.enforce()).more);
      expect(
        await evidenceCounts(
          evidence.lease.attemptId,
          evidence.command.delivery.outboxEventId,
        ),
      ).toEqual({ dispatches: 0, observations: 0, commands: 0 });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            'select count(*)::int count from app.node_attempts where workspace_id=$1 and id=$2',
            [workspaceA, evidence.lease.attemptId],
          ),
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(applyHealthCommand(evidence.command)).resolves.toEqual({
        kind: 'stale',
      });
      await expect(applyHealthCommand(evidence.command)).resolves.toEqual({
        kind: 'duplicate',
      });
      for (const forgedToken of [null, randomUUID()]) {
        const unauthorized = await asOwner(workspaceA, async (client) => {
          if (forgedToken !== null)
            await client.query(
              "select set_config('app.workspace_purge_delete_token',$1,true)",
              [forgedToken],
            );
          return client.query(
            "delete from app.inbox_receipts where workspace_id=$1 and message_id=$2 and consumer_name='connection-health-worker' returning message_id",
            [workspaceA, evidence.command.delivery.outboxEventId],
          );
        });
        expect(unauthorized.rowCount).toBe(0);
        const update = await asOwner(workspaceA, (client) =>
          client.query(
            "update app.inbox_receipts set completed_at=clock_timestamp() where workspace_id=$1 and message_id=$2 and consumer_name='connection-health-worker' returning message_id",
            [workspaceA, evidence.command.delivery.outboxEventId],
          ),
        );
        expect(update.rowCount).toBe(0);
      }
      expect(await readHealth(evidence.connection.connectionId)).toEqual(
        before,
      );
    } finally {
      await retention.close();
    }
  });

  it('includes both private health tables in bounded workspace tenant purge without dangling health commands', async () => {
    const evidence = await completedEvidence();
    const beforeDeletion = await readHealth(evidence.connection.connectionId);
    if (beforeDeletion === undefined)
      throw new Error('Expected retained connection before deletion');
    await withTenantScopedClient(
      api,
      { workspaceId: workspaceA, actorId },
      (client) =>
        changeWorkspaceLifecycle(client, {
          operationId: randomUUID(),
          workspaceId: workspaceA,
          actorUserId: actorId,
          commandType: 'deletion_requested',
          reason: 'Health tenant purge',
          idempotencyKeyHash: 'd'.repeat(64),
          requestHash: 'e'.repeat(64),
        }),
    );
    expect(await readHealth(evidence.connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: String(BigInt(beforeDeletion.health_revision) + 1n),
    });
    const provenance = await asOwner(workspaceA, (client) =>
      client.query(
        'select last_health_transition_at,last_health_transition_source from app.connections where workspace_id=$1 and id=$2',
        [workspaceA, evidence.connection.connectionId],
      ),
    );
    expect(provenance.rows).toEqual([
      { last_health_transition_at: null, last_health_transition_source: null },
    ]);
    await purgeWorkspace({
      adminUrl: databaseUrl(adminBase),
      maintenanceUrl: databaseUrl(maintenanceBase),
      workspaceId: workspaceA,
      pageSize: 10,
    });
    const receipts = await asOwner(workspaceA, (client) =>
      client.query(
        "select count(*)::int count from app.inbox_receipts where workspace_id=$1 and consumer_name='connection-health-worker'",
        [workspaceA],
      ),
    );
    expect(receipts.rows).toEqual([{ count: 0 }]);
    expect(
      await evidenceCounts(
        evidence.lease.attemptId,
        evidence.command.delivery.outboxEventId,
      ),
    ).toEqual({ dispatches: 0, observations: 0, commands: 0 });
    const survivors = await asOwner(workspaceA, (client) =>
      client.query(
        'select id from app.connection_health_observations union all select attempt_id from app.node_attempt_connection_dispatches',
      ),
    );
    expect(survivors.rows).toEqual([]);
  });
});
