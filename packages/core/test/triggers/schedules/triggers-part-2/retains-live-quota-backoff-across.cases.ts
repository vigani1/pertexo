import { actorId, ownerQuery, workspaceId } from './fixture.js';
import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { schedule } from './fixture.js';

export function registerRetainsLiveQuotaBackoffAcross(): void {
  it('retains live quota backoff across commands and clears resolved health evidence', async () => {
    const healthWorkflowId = randomUUID();
    const healthVersionId = randomUUID();
    const healthTriggerId = randomUUID();
    const fingerprint = `trigger:sha256:${createHash('sha256').update(healthTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,
         published_version_id,created_by)
       values($1,$2,'Schedule health policy','active','degraded',null,$3)`,
      [healthWorkflowId, workspaceId, actorId],
    );
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,'{}'::jsonb,$5)`,
      [
        healthVersionId,
        workspaceId,
        healthWorkflowId,
        `wf:sha256:${'d'.repeat(64)}`,
        actorId,
      ],
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [healthWorkflowId, healthVersionId],
    );
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
         node_id,kind,status,desired_config,config_fingerprint,health_status,last_error_code)
       values($1,$2,$3,$4,'schedule-health','schedule','active',$5::jsonb,$6,
         'degraded','schedule.admission_throttled')`,
      [
        healthTriggerId,
        workspaceId,
        healthWorkflowId,
        healthVersionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 5,
          misfirePolicy: 'catch_up_once',
        }),
        fingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
         admission_deferred_until,health_status,last_error_code)
       values($1,$2,'interval',5,'catch_up_once',$3,clock_timestamp()-interval '1 hour',
         clock_timestamp()-interval '5 minutes',clock_timestamp()+interval '2 minutes',
         'degraded','schedule.admission_throttled')`,
      [healthTriggerId, workspaceId, fingerprint],
    );
    const initial = await ownerQuery<{
      admission_deferred_until: Date;
      next_fire_at: Date;
    }>(
      `select admission_deferred_until,next_fire_at from app.trigger_schedules
        where trigger_id=$1`,
      [healthTriggerId],
    );
    const command = (suffix: string, enabled: boolean) => ({
      workspaceId,
      actorId,
      workflowId: healthWorkflowId,
      triggerId: healthTriggerId,
      enabled,
      idempotencyKey: `health-${suffix}`,
      requestHash: createHash('sha256')
        .update(`health-${suffix}`)
        .digest('hex'),
    });

    const noOp = await schedule.schedules.setEnabled(command('noop', true));
    expect(noOp.trigger).toMatchObject({
      status: 'active',
      healthStatus: 'degraded',
      lastErrorCode: 'schedule.admission_throttled',
    });
    expect(noOp.trigger.nextFireAt).toEqual(initial.rows[0]?.next_fire_at);

    const disabled = await schedule.schedules.setEnabled(
      command('disable', false),
    );
    expect(disabled.trigger).toMatchObject({
      status: 'disabled',
      healthStatus: 'disabled',
      lastErrorCode: null,
    });
    const reenabled = await schedule.schedules.setEnabled(
      command('reenable', true),
    );
    expect(reenabled.trigger).toMatchObject({
      status: 'active',
      healthStatus: 'degraded',
      lastErrorCode: 'schedule.admission_throttled',
    });
    await expect(
      ownerQuery(
        `select admission_deferred_until,next_fire_at from app.trigger_schedules
          where trigger_id=$1`,
        [healthTriggerId],
      ),
    ).resolves.toMatchObject({ rows: initial.rows });

    await ownerQuery(
      `update app.trigger_schedules set admission_deferred_until=clock_timestamp()-interval '1 second',
         health_status='degraded',last_error_code='schedule.scan_failed'
       where trigger_id=$1`,
      [healthTriggerId],
    );
    const recovered = await schedule.schedules.setEnabled(
      command('recover', true),
    );
    expect(recovered.trigger).toMatchObject({
      status: 'active',
      healthStatus: 'healthy',
      lastErrorCode: null,
    });
    await expect(
      ownerQuery<{ resolved: boolean }>(
        `select admission_deferred_until<=clock_timestamp() resolved
           from app.trigger_schedules where trigger_id=$1`,
        [healthTriggerId],
      ),
    ).resolves.toMatchObject({ rows: [{ resolved: true }] });
  });
}
