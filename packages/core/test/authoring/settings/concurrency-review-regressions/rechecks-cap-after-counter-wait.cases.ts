import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createTestRunStore } from '../../../support/run-advance-store.js';

import {
  apiUrl,
  hasPostgresCode,
  waitForDatabaseLock,
  workflowId,
  workflowVersionId,
  workspaceA,
} from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  readTickets,
  setLimit,
  withConcurrencyControls,
  withOwner,
} from '../concurrency-admission.fixtures.js';
import {
  workerUrl,
  insertionCases,
  publishExecutableVersion,
  startInput,
  reservations,
  deferredDelivery,
} from './fixture.js';

export function registerRechecksCapAfterCounterWait(): void {
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
}
