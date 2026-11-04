import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('preserves populated schedules on upgrade and stores caller-chosen retirement atomically only for the owning token', async () => {
  await withUpgradeDatabase(91, async ({ admin, upgrade }) => {
    const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
    const versionId = randomUUID(),
      triggerId = randomUUID(),
      token = randomUUID();
    await admin.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
      values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}', $4,'{}',$5)`,
      [
        versionId,
        workspaceId,
        workflowId,
        `wf:sha256:${'a'.repeat(64)}`,
        ownerId,
      ],
    );
    await admin.query(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,desired_config,config_fingerprint)
      values($1,$2,$3,$4,'schedule','schedule','active','{}',$5)`,
      [
        triggerId,
        workspaceId,
        workflowId,
        versionId,
        `trigger:sha256:${'b'.repeat(64)}`,
      ],
    );
    await admin.query(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,config_fingerprint,
      anchor_at,next_fire_at,lease_owner,lease_token,lease_acquired_at,lease_expires_at)
      values($1,$2,'interval',60,'catch_up_once',$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',
        'owner',$4,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,
      [triggerId, workspaceId, `trigger:sha256:${'b'.repeat(64)}`, token],
    );
    const state = async () =>
      (
        await admin.query<{ state: Record<string, unknown> }>(
          'select to_jsonb(s) state from app.trigger_schedules s where trigger_id=$1',
          [triggerId],
        )
      ).rows[0];
    const before = await state();
    await upgrade();
    expect(await state()).toEqual(before);
    const client = await admin.connect();
    const store = async (leaseToken: string) => {
      await client.query('begin');
      try {
        await client.query('set local role pertexo_app');
        const result = await client.query<{ stored: boolean }>(
          `select app.store_trigger_schedule_retirement($1,$2,'degraded','schedule.recurrence_invalid',clock_timestamp()+interval '60 seconds') stored`,
          [triggerId, leaseToken],
        );
        await client.query('commit');
        return result.rows[0];
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    };
    try {
      expect(await store(randomUUID())).toEqual({ stored: false });
      expect(await state()).toEqual(before);
      await admin.query(`create function public.reject_retirement() returns trigger language plpgsql as $$ begin raise exception 'Health storage unavailable'; end $$;
        create trigger reject_retirement before update on app.workflow_triggers for each row execute function public.reject_retirement()`);
      try {
        await expect(store(token)).rejects.toMatchObject({ code: 'P0001' });
      } finally {
        await admin.query(
          'drop trigger reject_retirement on app.workflow_triggers; drop function public.reject_retirement()',
        );
      }
      expect(await state()).toEqual(before);
      expect(await store(token)).toEqual({ stored: true });
      expect(
        (
          await admin.query(
            `select lease_token,health_status,last_error_code,
        extract(epoch from admission_deferred_until-clock_timestamp())::float8 seconds from app.trigger_schedules where trigger_id=$1`,
            [triggerId],
          )
        ).rows[0],
      ).toMatchObject({
        lease_token: null,
        health_status: 'degraded',
        last_error_code: 'schedule.recurrence_invalid',
        seconds: expect.any(Number) as unknown,
      });
      expect(
        (
          await admin.query(
            'select health_status,last_error_code from app.workflow_triggers where id=$1',
            [triggerId],
          )
        ).rows,
      ).toEqual([
        {
          health_status: 'degraded',
          last_error_code: 'schedule.recurrence_invalid',
        },
      ]);
      const retired = await state();
      expect(await store(token)).toEqual({ stored: false });
      expect(await state()).toEqual(retired);
    } finally {
      client.release();
    }
    expect(
      (
        await admin.query(`select to_regprocedure('app.defer_trigger_schedule_claim(uuid,uuid,integer)') old_defer,
      to_regprocedure('app.fail_trigger_schedule_claim(uuid,uuid)') old_fail`)
      ).rows,
    ).toEqual([{ old_defer: null, old_fail: null }]);
  });
}, 60_000);
