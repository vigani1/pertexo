import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('separates retirement from the audited operational choice on populated schedules', async () => {
  await withUpgradeDatabase(95, async ({ admin, upgrade }) => {
    const expected: { trigger_id: string; status: string; retired: boolean }[] =
      [];
    for (const disabled of [false, true]) {
      const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
      const versions = [randomUUID(), randomUUID()];
      const triggers = [randomUUID(), randomUUID()];
      for (const [i, versionId] of versions.entries()) {
        const triggerId = triggers[i];
        await admin.query(
          `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
          values($1,$2,$3,$4,'{"settings":{},"nodes":[],"edges":[]}',$5,'{}',$6)`,
          [
            versionId,
            workspaceId,
            workflowId,
            i + 1,
            `wf:sha256:${'a'.repeat(64)}`,
            ownerId,
          ],
        );
        await admin.query(
          `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,desired_config,config_fingerprint)
          values($1,$2,$3,$4,'schedule','schedule','disabled','{}',$5)`,
          [
            triggerId,
            workspaceId,
            workflowId,
            versionId,
            `trigger:sha256:${'b'.repeat(64)}`,
          ],
        );
        await admin.query(
          `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,status)
          values($1,$2,'interval',60,'skip',$3,clock_timestamp(),clock_timestamp()+interval '1 hour','disabled')`,
          [triggerId, workspaceId, `trigger:sha256:${'b'.repeat(64)}`],
        );
        if (triggerId === undefined) throw new Error('Missing trigger');
        expected.push({
          trigger_id: triggerId,
          status: i === 0 && !disabled ? 'enabled' : 'disabled',
          retired: i === 0,
        });
      }
      await admin.query(
        'update app.workflows set published_version_id=$1 where id=$2',
        [versions[1], workflowId],
      );
      if (disabled)
        await admin.query(
          `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id)
        values($1,$2,$3,'schedule_trigger.disabled','schedule_trigger',$4)`,
          [randomUUID(), workspaceId, ownerId, triggers[0]],
        );
    }
    await upgrade();
    const result = await admin.query<{
      trigger_id: string;
      status: string;
      retired: boolean;
    }>(
      'select trigger_id,status,retired_at is not null retired from app.trigger_schedules',
    );
    expect(result.rows).toEqual(expect.arrayContaining(expected));
    expect(result.rows).toHaveLength(expected.length);
  });
}, 60_000);
