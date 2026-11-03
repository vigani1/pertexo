import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it.each(['provision', 'settings'] as const)(
  'keeps all limits current when %s takes its lock first during workspace creation',
  async (first) => {
    await withUpgradeDatabase(80, async ({ admin, upgrade }) => {
      const { ownerId, workspaceId: existingWorkspace } =
        await seedWorkflow(admin);
      await admin.query(
        'insert into app.workspace_artifact_capacity(workspace_id) values($1)',
        [existingWorkspace],
      );
      await upgrade(81);
      const provision = await admin.connect(),
        settings = await admin.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await provision.query('begin');
        await settings.query('begin');
        await provision.query("set local statement_timeout='10s'");
        await settings.query("set local statement_timeout='10s'");
        const workspaceId = randomUUID();
        const insert = async () => {
          await provision.query(
            "insert into app.workspaces(id,name,slug,created_by) values($1::uuid,'Concurrent workspace',$1::text,$2)",
            [workspaceId, ownerId],
          );
          await provision.query(
            'insert into app.workspace_artifact_capacity(workspace_id) values($1)',
            [workspaceId],
          );
        };
        const apply = () =>
          settings.query('select app.apply_instance_capacity(37,12345,23456)');
        const [leader, waiter] =
          first === 'provision' ? [provision, settings] : [settings, provision];
        const leaderPid = (
          await leader.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        const waiterPid = (
          await waiter.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (first === 'provision') {
          await insert();
          pending = apply();
        } else {
          await apply();
          pending = insert();
        }
        // Wait for observed contention or completion, so the same schedule also
        // exposes stale saved limits when serialization is removed.
        const progress = { settled: false };
        const settled = pending.then(
          () => {
            progress.settled = true;
            return { ok: true };
          },
          (error: unknown) => {
            progress.settled = true;
            return { error };
          },
        );
        await expect
          .poll(async () => {
            const blockers = (
              await admin.query<{ blockers: number[] }>(
                'select pg_blocking_pids($1) blockers',
                [waiterPid],
              )
            ).rows[0]?.blockers;
            return (
              progress.settled ||
              (leaderPid !== undefined &&
                blockers?.includes(leaderPid) === true)
            );
          })
          .toBe(true);
        await leader.query('commit');
        expect(await settled).toEqual({ ok: true });
        await waiter.query('commit');
        for (const id of [existingWorkspace, workspaceId]) {
          expect(
            (
              await admin.query(
                `select v.active_run_limit,v.queued_run_limit,a.artifact_count_limit
          from app.workspace_execution_entitlements e
          join app.workspace_execution_entitlement_versions v on v.workspace_id=e.workspace_id and v.version=e.current_version
          join app.workspace_artifact_capacity a on a.workspace_id=e.workspace_id where e.workspace_id=$1`,
                [id],
              )
            ).rows,
          ).toEqual([
            {
              active_run_limit: 37,
              queued_run_limit: 12345,
              artifact_count_limit: 23456,
            },
          ]);
        }
        expect(
          (
            await admin.query(
              'select active_run_limit,queued_run_limit,artifact_count_limit from app.instance_capacity',
            )
          ).rows,
        ).toEqual([
          {
            active_run_limit: 37,
            queued_run_limit: 12345,
            artifact_count_limit: 23456,
          },
        ]);
      } finally {
        await Promise.all([
          provision.query('rollback'),
          settings.query('rollback'),
        ]);
        await pending?.catch(() => undefined);
        provision.release();
        settings.release();
      }
    });
  },
);
