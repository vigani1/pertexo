import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createRetentionEnforcementCoordinator } from '../src/lifecycle/retention.js';
import type { ControlLedger } from '../src/lifecycle/control-ledger-coordinator.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import {
  actorId,
  apiBaseUrl,
  migrationBaseUrl,
  retainedRunId,
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
import { createConnectionHealthUpgradeFixture } from './support/connection-health-upgrade.fixture.js';

const dispatcherBase =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
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
const upgrade = createConnectionHealthUpgradeFixture();
const readinessError =
  'Connection persistence schema or grants are incompatible';
const readinessOptions = {
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
  apiRuntimeRole: 'pertexo_api',
};

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminBase, max: 1 });
  try {
    const name = new URL(databaseUrl(migrationBaseUrl)).pathname.slice(1);
    if (!/^pertexo_test_[a-z0-9_]+$/u.test(name))
      throw new Error('Boundary test requires an isolated database');
    await admin.query(
      `grant connect on database "${name}" to pertexo_dispatcher,pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
  await upgrade.create();
}, 120_000);

afterAll(async () => {
  const outcomes = await Promise.allSettled([
    api.end(),
    worker.end(),
    dispatcher.end(),
    maintenance.end(),
    upgrade.close(),
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

async function ownerSql(statement: string): Promise<void> {
  await asOwner(workspaceA, async (client) => {
    await client.query(statement);
  });
}

async function assertDriftRejected(statement: string, restore: string) {
  await ownerSql(statement);
  try {
    for (const pool of [api, worker, dispatcher])
      await expect(
        checkDatabaseReadiness(pool, readinessOptions),
      ).rejects.toThrow(readinessError);
  } finally {
    await ownerSql(restore);
    await expect(
      checkDatabaseReadiness(api, readinessOptions),
    ).resolves.toMatchObject({
      migrationHead: '0141_native_attempt_lock_order.sql',
    });
  }
}

const appliedLedger: ControlLedger = {
  append: () =>
    Promise.reject(new Error('Retention must not invent ledger commands')),
  reconcile: (input) =>
    Promise.resolve({
      hasMore: false,
      reachedHighWater: true,
      pageEndHash: input.projectedHash,
      pageEndSequence: input.projectedSequence,
      records: [],
    }),
};

async function completedEvidence() {
  const connection = await createHealthConnection();
  const lease = await claimHealthAttempt(connection);
  await markHealthDispatched(lease, connection);
  await nodeAttemptStore.complete(healthCompletion(lease));
  const command = await healthCommand(lease);
  return { connection, lease, command };
}

async function currentControl() {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{ sequence: number; hash: string }>(
      'select retention_control_sequence::int sequence,retention_control_hash hash from app.workspaces where id=$1',
      [workspaceA],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Expected workspace control anchor');
  return row;
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

describe('connection health migration and runtime boundary', () => {
  it('upgrades exact 0127 retained metadata and lets an unversioned in-flight claim finish without changing health', async () => {
    await expect(upgrade.upgrade()).resolves.toEqual([
      '0128_connection_health.sql',
      '0129_workflow_duplication.sql',
      '0130_workflow_input_cases.sql',
      '0131_checked_manual_start.sql',
      '0132_workflow_portability.sql',
      '0133_curated_template_origin.sql',
      '0134_workflow_organization.sql',
      '0135_workflow_folders_batch_identity.sql',
      '0136_workflow_draft_graph_v2.sql',
      '0137_workflow_json_call_node_scope_index.sql',
      '0138_workflow_json_call_attempt_scope_index.sql',
      '0139_workflow_json_calls.sql',
      '0140_workflow_call_controls.sql',
      '0141_native_attempt_lock_order.sql',
    ]);
    const retained = await upgrade.asOwner((client) =>
      client.query(
        `select health_revision::text,last_tested_at,last_healthy_at,last_error_code,last_run_observed_at,last_health_transition_at,last_health_transition_source
       from app.connections where id=$1`,
        [upgrade.connectionId],
      ),
    );
    expect(retained.rows).toEqual([
      {
        health_revision: '1',
        last_tested_at: upgrade.historicalTime,
        last_healthy_at: upgrade.historicalTime,
        last_error_code: 'connection.historical_test',
        last_run_observed_at: null,
        last_health_transition_at: null,
        last_health_transition_source: null,
      },
    ]);
    const completed = await upgrade.completeLegacy();
    expect(completed.outcome).toMatchObject({ ok: true, httpStatus: 200 });
    expect(completed.connection).toMatchObject({
      lastTestedAt: upgrade.historicalTime,
      lastHealthyAt: upgrade.historicalTime,
      lastErrorCode: 'connection.historical_test',
    });
    const facts = await upgrade.asOwner((client) =>
      client.query(
        `select (select count(*)::int from app.connection_events where connection_id=$1 and event_type='connection.test_failed') historical,
         (select count(*)::int from app.connection_events where connection_id=$1 and event_type='connection.test_succeeded') completed,
         (select count(*)::int from app.connection_events where connection_id=$1 and event_type='connection.health_changed') transitions,
         (select status from app.idempotency_records where resource_id=$1 and operation='connection.test') claim_status`,
        [upgrade.connectionId],
      ),
    );
    expect(facts.rows).toEqual([
      {
        historical: 1,
        completed: 1,
        transitions: 0,
        claim_status: 'completed',
      },
    ]);
  });

  it('accepts the fresh protocol for every serving role without activating run health', async () => {
    for (const [pool, role] of [
      [api, 'pertexo_api'],
      [worker, 'pertexo_worker'],
      [dispatcher, 'pertexo_dispatcher'],
    ] as const)
      await expect(
        checkDatabaseReadiness(pool, readinessOptions),
      ).resolves.toMatchObject({ role });
  });

  it.each([
    'node_attempt_connection_dispatches',
    'connection_health_observations',
  ])(
    'rejects missing FORCE RLS and permissive policy drift on %s',
    async (table) => {
      await assertDriftRejected(
        `alter table app.${table} no force row level security`,
        `alter table app.${table} force row level security`,
      );
      await assertDriftRejected(
        `alter policy ${table}_workspace_scope on app.${table} using(true) with check(true)`,
        `alter policy ${table}_workspace_scope on app.${table} using(workspace_id::text=nullif(current_setting('app.workspace_id',true),'')) with check(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))`,
      );
    },
  );

  it('rejects changed function bodies and definer execution configuration', async () => {
    const signature =
      'app.apply_connection_health_observation(uuid,uuid,text,uuid,text)';
    const definition = await asOwner(workspaceA, (client) =>
      client.query<{ definition: string }>(
        'select pg_get_functiondef($1::regprocedure) definition',
        [signature],
      ),
    );
    const original = definition.rows[0]?.definition;
    if (original === undefined)
      throw new Error('Health application function missing');
    await assertDriftRejected(
      original.replace('BEGIN', 'BEGIN\n  PERFORM 1;'),
      original,
    );
    await assertDriftRejected(
      `alter function ${signature} set search_path=pg_catalog,app,pg_temp`,
      original,
    );
  });

  it.each([
    'inbox_receipts_owner_leased_purge_select',
    'inbox_receipts_owner_leased_purge_delete',
    'inbox_receipts_owner_leased_purge_lock',
  ])(
    'rejects widened health receipt purge authorization on %s',
    async (policy) => {
      const existing = await asOwner(workspaceA, (client) =>
        client.query<{ expression: string }>(
          "select pg_get_expr(polqual,polrelid) expression from pg_policy where polrelid='app.inbox_receipts'::regclass and polname=$1",
          [policy],
        ),
      );
      const expression = existing.rows[0]?.expression;
      if (expression === undefined)
        throw new Error('Expected scoped purge policy');
      await assertDriftRejected(
        `alter policy ${policy} on app.inbox_receipts using (true)`,
        `alter policy ${policy} on app.inbox_receipts using (${expression})`,
      );
    },
  );

  it('rejects widened outbox leased purge authorization', async () => {
    const policy = 'outbox_events_owner_leased_purge_delete';
    const existing = await asOwner(workspaceA, (client) =>
      client.query<{ expression: string }>(
        "select pg_get_expr(polqual,polrelid) expression from pg_policy where polrelid='app.outbox_events'::regclass and polname=$1",
        [policy],
      ),
    );
    const expression = existing.rows[0]?.expression;
    if (expression === undefined)
      throw new Error('Expected scoped purge policy');
    await assertDriftRejected(
      `alter policy ${policy} on app.outbox_events using (true)`,
      `alter policy ${policy} on app.outbox_events using (${expression})`,
    );
  });

  it('rejects index shape, check-constraint and trigger drift', async () => {
    await assertDriftRejected(
      'drop index app.connection_health_observations_workspace_time_idx; create index connection_health_observations_workspace_time_idx on app.connection_health_observations(workspace_id,id,observed_at)',
      'drop index app.connection_health_observations_workspace_time_idx; create index connection_health_observations_workspace_time_idx on app.connection_health_observations(workspace_id,observed_at,id)',
    );
    await assertDriftRejected(
      'alter table app.connections drop constraint connections_health_revision_positive; alter table app.connections add constraint connections_health_revision_positive check(health_revision>=0)',
      'alter table app.connections drop constraint connections_health_revision_positive; alter table app.connections add constraint connections_health_revision_positive check(health_revision>0)',
    );
    await assertDriftRejected(
      'alter table app.connection_health_observations disable trigger connection_health_observations_command_cleanup',
      'alter table app.connection_health_observations enable trigger connection_health_observations_command_cleanup',
    );
    await assertDriftRejected(
      'alter table app.connections disable trigger connections_health_protocol',
      'alter table app.connections enable trigger connections_health_protocol',
    );
  });

  it('rejects PUBLIC function execution and runtime table/column grant drift', async () => {
    const signature =
      'app.apply_connection_health_observation(uuid,uuid,text,uuid,text)';
    await assertDriftRejected(
      `grant execute on function ${signature} to public`,
      `revoke execute on function ${signature} from public`,
    );
    await assertDriftRejected(
      'grant select on app.connection_health_observations to pertexo_api',
      'revoke select on app.connection_health_observations from pertexo_api',
    );
    await assertDriftRejected(
      'grant update(applied_at) on app.connection_health_observations to pertexo_worker',
      'revoke update(applied_at) on app.connection_health_observations from pertexo_worker',
    );
    await assertDriftRejected(
      'grant select(reason_code) on app.connection_health_observations to pertexo_api',
      'revoke select(reason_code) on app.connection_health_observations from pertexo_api',
    );
  });

  it('rejects notification connection lock body and serving execute drift', async () => {
    const signature = 'app.lock_notification_connection(uuid,uuid)';
    const definition = await asOwner(workspaceA, (client) =>
      client.query<{ definition: string }>(
        'select pg_get_functiondef($1::regprocedure) definition',
        [signature],
      ),
    );
    const original = definition.rows[0]?.definition;
    if (original === undefined) throw new Error('Expected notification lock');
    const drifted = original.replace(
      'FOR SHARE OF connection',
      'FOR KEY SHARE OF connection',
    );
    expect(drifted).not.toBe(original);
    await assertDriftRejected(drifted, original);
    for (const role of ['pertexo_api', 'pertexo_worker'])
      await assertDriftRejected(
        `revoke execute on function ${signature} from ${role}`,
        `grant execute on function ${signature} to ${role}`,
      );
    await assertDriftRejected(
      `grant execute on function ${signature} to pertexo_dispatcher`,
      `revoke execute on function ${signature} from pertexo_dispatcher`,
    );
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

  it('proves API/dispatcher and worker negative ACLs plus tenant-fenced worker functions', async () => {
    for (const base of [apiBaseUrl, dispatcherBase]) {
      await expect(
        asRuntime(base, workspaceA, (client) =>
          client.query('select id from app.connection_health_observations'),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asRuntime(base, workspaceA, (client) =>
          client.query(
            "select app.apply_connection_health_observation($1,$2,'enforce',$3,$4)",
            [workspaceA, randomUUID(), randomUUID(), 'a'.repeat(64)],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          "update app.connections set status='reauthorization_required' where workspace_id=$1",
          [workspaceA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
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
  it('preserves evidence under legal hold, cascades it with source-attempt retention, removes its command and receipts late delivery as a no-op', async () => {
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
    const coordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({
        connectionString: databaseUrl(maintenanceBase),
        max: 2,
      }),
      appliedLedger,
      {
        leaseOwner: 'health-boundary-retention',
        leaseSeconds: 60,
        maxPagesPerBatch: 20,
        pageSize: 1,
      },
    );
    const holdId = randomUUID();
    try {
      await maintenance.query(
        "select app.project_workspace_legal_hold($1,1,$2,'legal_hold_placed',$3,$4,$5,'owned-boundary','case-health','Preserve source evidence',clock_timestamp())",
        [workspaceA, randomUUID(), holdId, '0'.repeat(64), 'b'.repeat(64)],
      );
      const heldBatch = randomUUID();
      await maintenance.query(
        "select app.start_retention_batch($1,$2,$3,'execution_detail','2026-08-01',false,'owned-boundary','Health evidence retention')",
        [heldBatch, workspaceA, `held-${heldBatch}`],
      );
      await expect(coordinator.processNext()).resolves.toMatchObject({
        batchId: heldBatch,
        status: 'paused',
      });
      expect(
        await evidenceCounts(
          evidence.lease.attemptId,
          evidence.command.delivery.outboxEventId,
        ),
      ).toEqual({ dispatches: 1, observations: 1, commands: 1 });
      await maintenance.query(
        "select app.project_workspace_legal_hold($1,2,$2,'legal_hold_released',$3,$4,$5,'owned-boundary','case-health','Release source evidence',clock_timestamp())",
        [workspaceA, randomUUID(), holdId, 'b'.repeat(64), 'c'.repeat(64)],
      );
      await expect(coordinator.processNext()).resolves.toMatchObject({
        batchId: heldBatch,
        status: 'completed',
      });
      for (const forgedToken of [null, randomUUID()]) {
        await expect(
          asOwner(workspaceA, async (client) => {
            await client.query(
              "select set_config('app.retention_batch_transition','on',true)",
            );
            if (forgedToken !== null) {
              await client.query(
                "select set_config('app.workspace_purge_delete_token',$1,true)",
                [forgedToken],
              );
            }
            return client.query(
              'delete from app.retention_batches where workspace_id=$1 and id=$2',
              [workspaceA, heldBatch],
            );
          }),
        ).rejects.toMatchObject({ code: '55000' });
      }
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
      await coordinator.close();
    }
  });

  it('includes both private health tables in bounded workspace tenant purge without dangling health commands', async () => {
    const evidence = await completedEvidence();
    // The shared fixture retains one phase-0 queued row and legacy node for
    // migration/CAS tests. Its old checkpoint isn't a current cancellation
    // checkpoint or entitlement. Terminalize only that explicit seed, not the
    // evidence run, with the current admission guard restored before commit.
    await asOwner(workspaceA, async (client) => {
      await client.query(
        'alter table app.workflow_runs no force row level security',
      );
      await client.query(
        'alter table app.workflow_runs disable trigger workflow_runs_execution_admission',
      );
      await client.query(
        "update app.workflow_runs set status='failed',completed_at=clock_timestamp() where workspace_id=$1 and id=$2 and status='queued'",
        [workspaceA, retainedRunId],
      );
      await client.query(
        'alter table app.workflow_runs enable trigger workflow_runs_execution_admission',
      );
      await client.query(
        'alter table app.workflow_runs force row level security',
      );
    });
    const requestHash = 'd'.repeat(64);
    const control = await currentControl();
    const beforeDeletion = await readHealth(evidence.connection.connectionId);
    if (beforeDeletion === undefined)
      throw new Error('Expected retained connection before deletion');
    const deletionSequence = control.sequence + 1;
    const purgeSequence = control.sequence + 2;
    await maintenance.query(
      "select app.project_workspace_deletion($1,$2,$3,'deletion_requested',$1,$4,$5,$6,null,'Health tenant purge',clock_timestamp()-interval '31 days')",
      [
        workspaceA,
        deletionSequence,
        randomUUID(),
        control.hash,
        requestHash,
        actorId,
      ],
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
    const prepared = await maintenance.query<{
      job_id: string;
      lease_token: string;
      lease_fence: string;
    }>(
      "select * from app.prepare_workspace_purge_job($1,$2,$3,'health-boundary',interval '1 minute')",
      [workspaceA, deletionSequence, requestHash],
    );
    const job = prepared.rows[0];
    if (job === undefined) throw new Error('Expected health purge job');
    const purgeHash = 'e'.repeat(64);
    await maintenance.query(
      'select app.project_workspace_purge_started($1,$2,$3,$4,$5,$6)',
      [
        job.job_id,
        job.lease_token,
        job.lease_fence,
        purgeSequence,
        requestHash,
        purgeHash,
      ],
    );
    const object = await maintenance.query<{
      lease_token: string;
      lease_fence: string;
      step_name: string;
    }>(
      "select * from app.claim_workspace_purge_step($1,$2,$3,'health-boundary',interval '1 minute')",
      [job.job_id, purgeSequence, purgeHash],
    );
    const objectLease = object.rows[0];
    if (objectLease === undefined)
      throw new Error('Expected object purge step');
    expect(objectLease.step_name).toBe('object_versions');
    await maintenance.query(
      'select app.checkpoint_workspace_object_versions_page($1,$2,$3,0,true,$4,$5)',
      [
        job.job_id,
        objectLease.lease_token,
        objectLease.lease_fence,
        purgeSequence,
        purgeHash,
      ],
    );
    let completed = false;
    for (let page = 0; page < 100 && !completed; page += 1) {
      const claimed = await maintenance.query<{
        lease_token: string;
        lease_fence: string;
        step_name: string;
      }>(
        "select * from app.claim_workspace_purge_step($1,$2,$3,'health-boundary',interval '1 minute')",
        [job.job_id, purgeSequence, purgeHash],
      );
      const lease = claimed.rows[0];
      if (lease === undefined)
        throw new Error('Expected bounded tenant purge step');
      expect(lease.step_name).toBe('tenant_rows');
      const result = await asRuntime(maintenanceBase, workspaceA, (client) =>
        client.query<{ completed: boolean }>(
          'select * from app.execute_workspace_tenant_rows_page($1,$2,$3,10,$4,$5)',
          [
            job.job_id,
            lease.lease_token,
            lease.lease_fence,
            purgeSequence,
            purgeHash,
          ],
        ),
      );
      completed = result.rows[0]?.completed === true;
    }
    expect(completed).toBe(true);
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
