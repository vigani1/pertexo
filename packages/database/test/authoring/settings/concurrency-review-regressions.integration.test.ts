import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../../../src/config.js';
import { createTestRunStore } from '../../support/run-advance-store.js';
import type { LeasedOutboxEvent } from '../../../src/outbox/dispatcher/contracts.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../../src/outbox/events.js';
import {
  apiUrl,
  apiDatabase,
  hasPostgresCode,
  installExecutionAcceptanceFixture,
  migrationUrl,
  waitForDatabaseLock,
  workflowId,
  workflowVersionId,
  workspaceA,
  workspaceB,
  workspaceCreatorId,
} from '../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  readTickets,
  setLimit,
  withConcurrencyControls,
  withOwner,
  withDispatcher,
} from './concurrency-admission.fixtures.js';

installExecutionAcceptanceFixture();

function workerUrl() {
  const url = new URL(process.env.DATABASE_URL ?? migrationUrl);
  if (process.env.DATABASE_URL === undefined) {
    url.username = 'pertexo_app';
    url.password = 'pertexo-local-app';
  }
  url.pathname = new URL(migrationUrl).pathname;
  return url.toString();
}

const insertionCases = (['API', 'worker'] as const).flatMap((role) =>
  (['running', 'waiting'] as const).flatMap((status) =>
    [false, true].map((protocol) => ({ role, status, protocol })),
  ),
);

describe('workflow concurrency review regressions', () => {
  it.each(insertionCases)(
    'rechecks cap after counter wait for $role direct $status INSERT, protocol=$protocol',
    async ({ role, status, protocol }) => {
      await withConcurrencyControls(async (_controls, scope) => {
        const settingsPool = new Pool({ connectionString: apiUrl, max: 1 });
        const writerPool = new Pool({
          connectionString: role === 'API' ? apiUrl : workerUrl(),
          max: 1,
        });
        const settings = await settingsPool.connect();
        const writer = await writerPool.connect();
        let inserting:
          | Promise<{ kind: 'committed' } | { kind: 'denied'; error: unknown }>
          | undefined;
        try {
          await settings.query('begin');
          await settings.query(
            "select set_config('app.workspace_id',$1,true)",
            [scope.workspaceId],
          );
          await settings.query("select set_config('app.actor_id',$1,true)", [
            scope.actorId,
          ]);
          // A limit change holds the admission lock until it commits.
          await settings.query('select app.lock_workspace_admission($1)', [
            scope.workspaceId,
          ]);
          await settings.query(
            `insert into app.workflow_concurrency_policies
               (workspace_id, workflow_id, active_run_limit, revision)
             values ($1, $2, 1, 2)
             on conflict (workspace_id, workflow_id) do update
             set active_run_limit = 1,
                 revision = app.workflow_concurrency_policies.revision + 1`,
            [scope.workspaceId, scope.workflowId],
          );
          await writer.query('begin');
          await writer.query("select set_config('app.workspace_id',$1,true)", [
            workspaceA,
          ]);
          if (protocol)
            await writer.query(
              "select set_config('app.workflow_concurrency_protocol','1',true)",
            );
          const pid = (
            await writer.query<{ pid: number }>('select pg_backend_pid() pid')
          ).rows[0]?.pid;
          if (pid === undefined)
            throw new Error('Missing blocked INSERT process');
          const settingsPid = (
            await settings.query<{ pid: number }>('select pg_backend_pid() pid')
          ).rows[0]?.pid;
          if (settingsPid === undefined)
            throw new Error('Missing settings lock owner');
          inserting = writer
            .query(
              `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
             values($1,$2,$3,$4,'api',$5)`,
              [randomUUID(), workspaceA, workflowId, workflowVersionId, status],
            )
            .then(
              async () => {
                await writer.query('commit');
                return { kind: 'committed' as const };
              },
              (error: unknown) => ({ kind: 'denied' as const, error }),
            );
          // A real settings command holds the counter with an invisible cap.
          // Observe the INSERT waiting there before committing the setting.
          await waitForDatabaseLock(pid, 'waiter');
          await withOwner(async (observer) => {
            const blocked = await observer.query<{ by_settings: boolean }>(
              'select $1::int=any(pg_blocking_pids($2::int)) by_settings',
              [settingsPid, pid],
            );
            expect(blocked.rows[0]?.by_settings).toBe(true);
          });
          await settings.query('commit');
          const outcome = await inserting;
          expect(outcome).toMatchObject({ kind: 'denied' });
          if (outcome.kind !== 'denied')
            throw new Error(
              'Direct active INSERT bypassed committed workflow cap',
            );
          expect(outcome.error).toSatisfy(
            hasPostgresCode(protocol ? 'PTC02' : 'PTC01'),
          );
        } finally {
          await settings.query('rollback').catch(() => undefined);
          await inserting;
          await writer.query('rollback').catch(() => undefined);
          settings.release();
          writer.release();
          await Promise.all([settingsPool.end(), writerPool.end()]);
        }
      });
    },
  );

  it('preserves grandfathered reservation through real FIFO deferral, restart, and duplicate delivery', async () => {
    await setLimit(2);
    await publishExecutableVersion();
    const first = await acceptRun();
    const second = await acceptRun();
    await acceptRun();
    const firstClaim = await claimRuns();
    const secondClaim = await claimRuns();
    await publishClaims(firstClaim);
    await publishClaims(secondClaim);
    const firstEvent = firstClaim.events[0];
    const secondEvent = secondClaim.events[0];
    if (firstEvent === undefined || secondEvent === undefined)
      throw new Error('Missing ordered committed reservations');
    expect(firstEvent.aggregateId).toBe(first.runId);
    expect(secondEvent.aggregateId).toBe(second.runId);
    const original = await reservations();
    const tickets = await readTickets();
    await setLimit(1);
    const config = parseDatabaseConfig({
      connectionString: workerUrl(),
      max: 1,
    });
    let store = createTestRunStore(config);
    const secondInput = startInput(
      secondEvent,
      second.request.initialCheckpoint,
    );
    try {
      await expect(store.commitAdvancePlan(secondInput)).resolves.toEqual({
        kind: 'deferred',
        revision: 0,
      });
      const deferred = await deferredDelivery(second.runId, secondEvent.id);
      const afterDeferral = await reservations();
      // The same run's committed slot survives FIFO deferral and lowering.
      expect(afterDeferral).toHaveLength(2);
      expect(
        afterDeferral.find(
          ({ workflow_run_id }) => workflow_run_id === second.runId,
        ),
      ).toEqual({
        ...original.find(
          ({ workflow_run_id }) => workflow_run_id === second.runId,
        ),
        outbox_event_id: deferred.id,
      });
      expect(await readTickets()).toEqual(tickets);
      // A duplicate of the deferred delivery changes nothing.
      await expect(store.commitAdvancePlan(secondInput)).resolves.toEqual({
        kind: 'already_committed',
        revision: 0,
      });
      expect(await reservations()).toEqual(afterDeferral);
      await store.close();
      store = createTestRunStore(config);
      await expect(store.commitAdvancePlan(secondInput)).resolves.toEqual({
        kind: 'already_committed',
        revision: 0,
      });
      expect(await reservations()).toEqual(afterDeferral);
      await expect(claimRuns()).resolves.toMatchObject({ events: [] });
      await expect(
        store.commitAdvancePlan(
          startInput(firstEvent, first.request.initialCheckpoint),
        ),
      ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
      await withOwner((client) =>
        client.query(
          "update app.outbox_events set available_at=clock_timestamp()-interval '1 second' where id=$1",
          [deferred.id],
        ),
      );
      const retry = await claimRuns();
      expect(retry.events.map(({ id }) => id)).toEqual([deferred.id]);
      await publishClaims(retry);
      const nextInput = {
        ...secondInput,
        delivery: {
          outboxEventId: deferred.id,
          payloadChecksum: deferred.payload_checksum,
        },
      };
      await expect(store.commitAdvancePlan(nextInput)).resolves.toMatchObject({
        kind: 'committed',
        revision: 1,
      });
      await expect(store.commitAdvancePlan(nextInput)).resolves.toEqual({
        kind: 'already_committed',
        revision: 1,
      });
      expect(await reservations()).toEqual([]);
      await expect(claimRuns()).resolves.toMatchObject({ events: [] });
      const counts = await withOwner(
        async (client) =>
          (
            await client.query<{ active: number; starts: number }>(
              `select (select count(*)::int from app.workflow_runs where status in ('running','waiting')) active,
         (select count(*)::int from app.run_events where type='run.started') starts`,
            )
          ).rows[0],
      );
      expect(counts).toEqual({ active: 2, starts: 2 });
      expect(await readTickets()).toEqual(tickets);
    } finally {
      await store.close();
    }
  });

  it('restricts reservation rebind to the app role and installed workspace context', async () => {
    const run = await acceptRun();
    const next = await pendingDelivery(run.runId);
    const ids = [workspaceA, run.runId, run.outboxEventId, next] as const;
    await expect(
      withDispatcher((client) =>
        client.query(
          'select app.rebind_workflow_run_active_admission($1,$2,$3,$4)',
          [...ids],
        ),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
    await expect(
      withWorker((client) =>
        client.query(
          'select app.rebind_workflow_run_active_admission($1,$2,$3,$4)',
          [workspaceB, run.runId, run.outboxEventId, next],
        ),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('rejects foreign run, old/new outbox, and forged payload bindings without mutation', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const other = await acceptRun();
    const grant = await claimRuns();
    await publishClaims(grant);
    const next = await pendingDelivery(first.runId);
    const otherNext = await pendingDelivery(other.runId);
    const forged = await pendingDelivery(first.runId, other.runId);
    const before = await reservations();
    for (const [run, old, target] of [
      [randomUUID(), first.outboxEventId, next],
      [first.runId, other.outboxEventId, next],
      [first.runId, first.outboxEventId, otherNext],
      [first.runId, first.outboxEventId, forged],
      [first.runId, first.outboxEventId, first.outboxEventId],
    ] as const) {
      expect(await rebind(run, old, target)).toBe(false);
      expect(await reservations()).toEqual(before);
    }
  });

  it('does not steal a reservation whose transport identity was rebound by real recovery', async () => {
    await setLimit(1);
    const run = await acceptRun();
    const initial = await claimRuns();
    await publishClaims(initial);
    await withOwner((client) =>
      client.query(
        "update app.workflow_run_active_admissions set recover_after=clock_timestamp()-interval '1 second' where workflow_run_id=$1",
        [run.runId],
      ),
    );
    const recovered = await claimRuns();
    const recoveredEvent = recovered.events[0];
    if (recoveredEvent === undefined)
      throw new Error('Missing recovered reservation transport');
    expect(recoveredEvent.id).not.toBe(run.outboxEventId);
    const before = await reservations();
    const attempted = await pendingDelivery(run.runId);
    expect(await rebind(run.runId, run.outboxEventId, attempted)).toBe(false);
    expect(await reservations()).toEqual(before);
    expect(before[0]?.outbox_event_id).toBe(recoveredEvent.id);
    expect(before[0]?.recovery_count).toBe(1);
  });
});

/** Advancing a run reads its published version, so one must exist. */
async function publishExecutableVersion(): Promise<void> {
  await withOwner(async (client) => {
    await client.query(
      'alter table app.workflow_versions no force row level security',
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,schema_version,graph_json,
         checksum,executable_json,published_by
       ) values ($1,$2,$3,1,1,'{}'::jsonb,$4,$5::jsonb,$6)
       on conflict (id) do nothing`,
      [
        workflowVersionId,
        workspaceA,
        workflowId,
        `wf:sha256:${'c'.repeat(64)}`,
        JSON.stringify({ schemaVersion: 2, graph: { nodes: [], edges: [] } }),
        workspaceCreatorId,
      ],
    );
    await client.query(
      'alter table app.workflow_versions force row level security',
    );
  });
}

function startInput(
  event: LeasedOutboxEvent,
  initial: Awaited<
    ReturnType<typeof acceptRun>
  >['request']['initialCheckpoint'],
) {
  return {
    workspaceId: workspaceA,
    runId: event.aggregateId,
    workflowVersionId,
    delivery: {
      outboxEventId: event.id,
      payloadChecksum: event.payloadChecksum,
    },
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: {
        ...initial,
        revision: 1,
        runStatus: 'running' as const,
        nextEventSequence: 3,
      },
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    },
  };
}

function reservations() {
  return withOwner(
    async (client) =>
      (
        await client.query<{
          workflow_run_id: string;
          outbox_event_id: string;
          created_at: Date;
          recovery_count: number;
          workflow_concurrency_order_exempt: boolean;
        }>(`select workflow_run_id,outbox_event_id,created_at,recovery_count::integer recovery_count,workflow_concurrency_order_exempt
      from app.workflow_run_active_admissions order by workflow_run_id`)
      ).rows,
  );
}

async function deferredDelivery(runId: string, originalEventId: string) {
  const events = await withOwner(
    async (client) =>
      (
        await client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events where aggregate_id=$1 and id<>$2
      and job_name='advance-workflow-run' order by created_at`,
          [runId, originalEventId],
        )
      ).rows,
  );
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined)
    throw new Error('Missing deferred transport identity');
  return event;
}

async function withWorker<T>(operation: (client: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: workerUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function pendingDelivery(runId: string, payloadRunId = runId) {
  const id = randomUUID();
  const payload = {
    schemaVersion: 1,
    workspaceId: workspaceA,
    outboxEventId: id,
    runId: payloadRunId,
  };
  await apiDatabase.withWorkspace(workspaceA, (transaction) =>
    insertOutboxEvent(transaction, {
      id,
      jobName: 'advance-workflow-run',
      schemaVersion: 1,
      aggregateType: 'workflow-run',
      aggregateId: runId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      availableAt: new Date(),
    }),
  );
  return id;
}

function rebind(runId: string, oldId: string, newId: string) {
  return withWorker(
    async (client) =>
      (
        await client.query<{ rebound: boolean }>(
          'select app.rebind_workflow_run_active_admission($1,$2,$3,$4) rebound',
          [workspaceA, runId, oldId, newId],
        )
      ).rows[0]?.rebound,
  );
}
