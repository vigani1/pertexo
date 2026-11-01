import {
  actorId,
  checkpointFactory,
  ownerQuery,
  workspaceId,
} from './fixture.js';
import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { schedule, quotaTriggerId } from './fixture.js';

export function registerDeduplicatesOccurrencePreservesSaturatedOccurrence(): void {
  it('deduplicates an occurrence and preserves a saturated occurrence until capacity recovers', async () => {
    const dedupeWorkflowId = randomUUID();
    const dedupeVersionId = randomUUID();
    const dedupeTriggerId = randomUUID();
    const dedupeFingerprint = `trigger:sha256:${createHash('sha256').update(dedupeTriggerId).digest('hex')}`;
    await ownerQuery(
      `update app.trigger_schedules set status='disabled'
        where workspace_id=$1`,
      [workspaceId],
    );
    await ownerQuery(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,
         published_version_id,created_by)
       values($1,$2,'Schedule dedupe and quota','active','active',null,$3)`,
      [dedupeWorkflowId, workspaceId, actorId],
    );
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,'{}'::jsonb,$5)`,
      [
        dedupeVersionId,
        workspaceId,
        dedupeWorkflowId,
        `wf:sha256:${'e'.repeat(64)}`,
        actorId,
      ],
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [dedupeWorkflowId, dedupeVersionId],
    );
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
         node_id,kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,'schedule-dedupe','schedule','active',$5::jsonb,$6,'healthy')`,
      [
        dedupeTriggerId,
        workspaceId,
        dedupeWorkflowId,
        dedupeVersionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 1,
          misfirePolicy: 'catch_up_once',
        }),
        dedupeFingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',1,'catch_up_once',$3,
         clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,
      [dedupeTriggerId, workspaceId, dedupeFingerprint],
    );
    await expect(
      schedule.scannerOne.scanDue({
        leaseOwner: 'dedupe-prerequisite-scanner',
        limit: 1,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ accepted: 1 });
    const first = await ownerQuery<{
      scheduled_at: Date;
      workflow_run_id: string;
    }>(
      'select scheduled_at,workflow_run_id from app.trigger_schedule_occurrences where trigger_id=$1',
      [dedupeTriggerId],
    );
    const firstOccurrence = first.rows[0];
    if (firstOccurrence === undefined)
      throw new Error('Accepted schedule occurrence missing');
    const scheduledAt = firstOccurrence.scheduled_at;
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,next_fire_at=$2
        where trigger_id=$1`,
      [dedupeTriggerId, scheduledAt],
    );
    await schedule.scannerOne.scanDue({
      leaseOwner: 'duplicate-scanner',
      limit: 1,
      leaseSeconds: 30,
      onTimeWindowSeconds: 300,
      checkpointFactory,
    });
    const duplicateFacts = await ownerQuery(
      `select (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) occurrences,
              (select count(*) from app.workflow_runs
                where workflow_id=$2 and trigger_type='schedule') runs`,
      [dedupeTriggerId, dedupeWorkflowId],
    );
    expect(duplicateFacts.rows[0]).toMatchObject({
      occurrences: '1',
      runs: '1',
    });

    const fingerprint = `trigger:sha256:${createHash('sha256').update(quotaTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,
         kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,'schedule-quota','schedule','active',$5::jsonb,$6,'healthy')`,
      [
        quotaTriggerId,
        workspaceId,
        dedupeWorkflowId,
        dedupeVersionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 1,
          misfirePolicy: 'catch_up_once',
        }),
        fingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,interval_minutes,
         misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',1,'catch_up_once',$3,clock_timestamp()-interval '2 minutes',
         clock_timestamp()-interval '1 minute')`,
      [quotaTriggerId, workspaceId, fingerprint],
    );
    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,1,'-infinity')`,
      [workspaceId],
    );
    await ownerQuery(
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [workspaceId],
    );
    await expect(
      schedule.scannerOne.scanDue({
        leaseOwner: 'quota-scanner',
        limit: 10,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ deferred: 1 });
    const backlog = await ownerQuery<{ due: boolean }>(
      'select next_fire_at<=clock_timestamp() due from app.trigger_schedules where trigger_id=$1',
      [quotaTriggerId],
    );
    expect(backlog.rows[0]?.due).toBe(true);
    await expect(
      ownerQuery(
        `select health_status,last_error_code from app.trigger_schedules where trigger_id=$1`,
        [quotaTriggerId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          health_status: 'degraded',
          last_error_code: 'schedule.admission_throttled',
        },
      ],
    });
    await ownerQuery(
      `update app.workflow_runs set status='succeeded'
        where workspace_id=$1 and status='queued'`,
      [workspaceId],
    );
    await ownerQuery(
      `update app.trigger_schedules set admission_deferred_until=clock_timestamp()
        where trigger_id=$1`,
      [quotaTriggerId],
    );
    await expect(
      schedule.scannerOne.scanDue({
        leaseOwner: 'recovery-scanner',
        limit: 10,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ accepted: 1 });
    const advanced = await ownerQuery<{ advanced: boolean }>(
      'select next_fire_at>clock_timestamp() advanced from app.trigger_schedules where trigger_id=$1',
      [quotaTriggerId],
    );
    expect(advanced.rows[0]?.advanced).toBe(true);
    await expect(
      ownerQuery(
        `select health_status,last_error_code from app.trigger_schedules where trigger_id=$1`,
        [quotaTriggerId],
      ),
    ).resolves.toMatchObject({
      rows: [{ health_status: 'healthy', last_error_code: null }],
    });
  });
}
