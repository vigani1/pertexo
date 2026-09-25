import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalOutboxPayloadChecksum } from '../src/execution/outbox.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

const schedule = createScheduleTriggerTestEnvironment();
const {
  actorId,
  checkpointFactory,
  ownerQuery,
  skipTriggerId,
  triggerId,
  workflowId,
  workspaceId,
} = schedule;
const quotaTriggerId = randomUUID();

beforeAll(async () => {
  await schedule.initialize();
  const interruptedClaim = await schedule.worker.query<{ trigger_id: string }>(
    'select * from app.claim_due_trigger_schedules($1,1,1)',
    ['initial-interrupted-scanner'],
  );
  if (interruptedClaim.rows[0]?.trigger_id !== triggerId) {
    throw new Error('Expected schedule prerequisite claim was not established');
  }
  const skippedScan = await schedule.scannerOne.scanDue({
    leaseOwner: 'initial-skip-scanner',
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });
  if (skippedScan.skipped !== 1) {
    throw new Error('Skipped schedule prerequisite was not established');
  }
  await ownerQuery(
    `update app.trigger_schedules
        set lease_acquired_at=clock_timestamp()-interval '2 seconds',
            lease_expires_at=clock_timestamp()-interval '1 second'
      where trigger_id=$1`,
    [triggerId],
  );
  const acceptedScan = await schedule.scannerOne.scanDue({
    leaseOwner: 'initial-acceptance-scanner',
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });
  if (acceptedScan.accepted !== 1) {
    throw new Error('Accepted schedule prerequisite was not established');
  }
}, 60_000);
afterAll(schedule.close);

describe('schedule trigger PostgreSQL slice', () => {
  it('deduplicates an occurrence and preserves a saturated occurrence until capacity recovers', async () => {
    const dedupeWorkflowId = randomUUID();
    const dedupeVersionId = randomUUID();
    const dedupeTriggerId = randomUUID();
    const dedupeFingerprint = `trigger:v1:sha256:${createHash('sha256').update(dedupeTriggerId).digest('hex')}`;
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
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
         schema_version,graph_json,checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by)
       values($1,$2,$3,1,1,'{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,2,'{}'::jsonb,1,$5)`,
      [
        dedupeVersionId,
        workspaceId,
        dedupeWorkflowId,
        `wf:v2:sha256:${'e'.repeat(64)}`,
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

    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(quotaTriggerId).digest('hex')}`;
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

  it('retains live quota backoff across commands and clears resolved health evidence', async () => {
    const healthWorkflowId = randomUUID();
    const healthVersionId = randomUUID();
    const healthTriggerId = randomUUID();
    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(healthTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,
         published_version_id,created_by)
       values($1,$2,'Schedule health policy','active','degraded',null,$3)`,
      [healthWorkflowId, workspaceId, actorId],
    );
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
         schema_version,graph_json,checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by)
       values($1,$2,$3,1,1,'{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,2,'{}'::jsonb,1,$5)`,
      [
        healthVersionId,
        workspaceId,
        healthWorkflowId,
        `wf:v2:sha256:${'d'.repeat(64)}`,
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

  it('records skip, supersedes publication, and operates on only the resulting current schedule', async () => {
    const skipped = await ownerQuery(
      `select disposition,workflow_run_id from app.trigger_schedule_occurrences
        where trigger_id=$1`,
      [skipTriggerId],
    );
    expect(skipped.rows).toEqual([
      { disposition: 'skipped', workflow_run_id: null },
    ]);
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,
         next_fire_at=clock_timestamp()-interval '1 minute'
        where trigger_id=$1`,
      [skipTriggerId],
    );
    const disabledNext = await schedule.schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId,
      triggerId: skipTriggerId,
      enabled: false,
      idempotencyKey: 'disable-skip',
      requestHash: createHash('sha256').update('disable-skip').digest('hex'),
    });
    expect(disabledNext.trigger.status).toBe('disabled');
    const retained = await ownerQuery<{ next_fire_at: Date }>(
      'select next_fire_at from app.trigger_schedules where trigger_id=$1',
      [skipTriggerId],
    );
    await schedule.schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId,
      triggerId: skipTriggerId,
      enabled: true,
      idempotencyKey: 'enable-skip',
      requestHash: createHash('sha256').update('enable-skip').digest('hex'),
    });
    const reenabled = await ownerQuery<{ advanced: boolean }>(
      `select next_fire_at>$2 advanced from app.trigger_schedules where trigger_id=$1`,
      [skipTriggerId, retained.rows[0]?.next_fire_at],
    );
    expect(reenabled.rows[0]?.advanced).toBe(true);

    const nextVersionId = randomUUID();
    const nextTriggerId = randomUUID();
    const outboxEventId = randomUUID();
    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(nextTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,schema_version,
         graph_json,checksum,executable_schema_version,executable_json,compatibility_release_epoch,published_by)
       values($1,$2,$3,2,1,'{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,2,'{}'::jsonb,1,$5)`,
      [
        nextVersionId,
        workspaceId,
        workflowId,
        `wf:v2:sha256:${'b'.repeat(64)}`,
        actorId,
      ],
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$1 where id=$2',
      [nextVersionId, workflowId],
    );
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,
         kind,status,desired_config,config_fingerprint)
       values($1,$2,$3,$4,'schedule-main','schedule','desired',$5::jsonb,$6)`,
      [
        nextTriggerId,
        workspaceId,
        workflowId,
        nextVersionId,
        JSON.stringify({
          kind: 'interval',
          intervalMinutes: 5,
          misfirePolicy: 'catch_up_once',
        }),
        fingerprint,
      ],
    );
    await ownerQuery(
      `insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,
         aggregate_id,payload,payload_checksum)
       values($1,$2,'reconcile-workflow-triggers',1,'workflow',$3,$4::jsonb,$5)`,
      [
        outboxEventId,
        workspaceId,
        workflowId,
        JSON.stringify({
          schemaVersion: 1,
          workspaceId,
          outboxEventId,
          workflowId,
          publishedVersionId: nextVersionId,
        }),
        canonicalOutboxPayloadChecksum({
          schemaVersion: 1,
          workspaceId,
          outboxEventId,
          workflowId,
          publishedVersionId: nextVersionId,
        }),
      ],
    );
    await expect(
      schedule.reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: nextVersionId,
        outboxEventId,
      }),
    ).resolves.toMatchObject([{ id: nextTriggerId, status: 'active' }]);
    const state = await ownerQuery(
      `select old.status old_status,new.interval_minutes,
              (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) old_occurrences
         from app.trigger_schedules old cross join app.trigger_schedules new
        where old.trigger_id=$1 and new.trigger_id=$2`,
      [triggerId, nextTriggerId],
    );
    expect(state.rows[0]).toMatchObject({
      old_status: 'disabled',
      interval_minutes: 5,
      old_occurrences: '1',
    });

    const listed = await schedule.schedules.list({
      workspaceId,
      actorId,
      workflowId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('configFingerprint');
    expect(listed[0]).not.toHaveProperty('leaseOwner');
    const currentTrigger = listed[0];
    if (currentTrigger === undefined)
      throw new Error('Current schedule missing');

    const nextBefore = await ownerQuery<{ next_fire_at: Date }>(
      'select next_fire_at from app.trigger_schedules where trigger_id=$1',
      [currentTrigger.id],
    );
    const command = {
      workspaceId,
      actorId,
      workflowId,
      triggerId: currentTrigger.id,
      enabled: false,
      idempotencyKey: 'disable-main',
      requestHash: createHash('sha256').update('disable-main').digest('hex'),
      requestId: 'schedule-request',
    } as const;
    const first = await schedule.schedules.setEnabled(command);
    const replay = await schedule.schedules.setEnabled(command);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    const facts = await ownerQuery<{
      next_fire_at: Date;
      audit_count: string;
    }>(
      `select schedule.next_fire_at,
              (select count(*) from app.audit_events where target_id=$1
                and action='schedule_trigger.disabled') audit_count
         from app.trigger_schedules schedule where schedule.trigger_id=$1`,
      [currentTrigger.id],
    );
    expect(facts.rows[0]?.next_fire_at).toEqual(
      nextBefore.rows[0]?.next_fire_at,
    );
    expect(facts.rows[0]?.audit_count).toBe('1');

    await expect(
      schedule.schedules.setEnabled({
        ...command,
        enabled: true,
        requestHash: createHash('sha256').update('enable-main').digest('hex'),
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'ScheduleTriggerError',
    });
    await expect(
      schedule.schedules.list({
        workspaceId: randomUUID(),
        actorId,
        workflowId,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'ScheduleTriggerError',
    });

    const enabled = await schedule.schedules.setEnabled({
      ...command,
      enabled: true,
      idempotencyKey: 'enable-main',
      requestHash: createHash('sha256').update('enable-main').digest('hex'),
    });
    expect(enabled.trigger.nextFireAt).toEqual(first.trigger.nextFireAt);
  });
});
