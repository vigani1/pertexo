import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalOutboxPayloadChecksum } from '../src/outbox.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

const schedule = createScheduleTriggerTestEnvironment();
const {
  actorId,
  checkpointFactory,
  ownerQuery,
  reconciliation,
  scannerOne,
  schedules,
  skipTriggerId,
  triggerId,
  versionId,
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
  const skippedScan = await scannerOne.scanDue({
    leaseOwner: 'initial-skip-scanner',
    limit: 1,
    leaseSeconds: 30,
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
  const acceptedScan = await scannerOne.scanDue({
    leaseOwner: 'initial-acceptance-scanner',
    limit: 1,
    leaseSeconds: 30,
    checkpointFactory,
  });
  if (acceptedScan.accepted !== 1) {
    throw new Error('Accepted schedule prerequisite was not established');
  }
}, 60_000);
afterAll(schedule.close);

describe('schedule trigger PostgreSQL slice', () => {
  it('deduplicates an occurrence and preserves a saturated occurrence until capacity recovers', async () => {
    const first = await ownerQuery<{
      scheduled_at: Date;
      workflow_run_id: string;
    }>(
      'select scheduled_at,workflow_run_id from app.trigger_schedule_occurrences where trigger_id=$1',
      [triggerId],
    );
    const firstOccurrence = first.rows[0];
    if (firstOccurrence === undefined)
      throw new Error('Accepted schedule occurrence missing');
    const scheduledAt = firstOccurrence.scheduled_at;
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,next_fire_at=$2
        where trigger_id=$1`,
      [triggerId, scheduledAt],
    );
    await scannerOne.scanDue({
      leaseOwner: 'duplicate-scanner',
      limit: 1,
      leaseSeconds: 30,
      checkpointFactory,
    });
    const duplicateFacts = await ownerQuery(
      `select (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) occurrences,
              (select count(*) from app.workflow_runs
                where workflow_id=$2 and trigger_type='schedule') runs`,
      [triggerId, workflowId],
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
        workflowId,
        versionId,
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
      scannerOne.scanDue({
        leaseOwner: 'quota-scanner',
        limit: 10,
        leaseSeconds: 30,
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
      "update app.workflow_runs set status='succeeded' where id=$1",
      [first.rows[0]?.workflow_run_id],
    );
    await ownerQuery(
      `update app.trigger_schedules set admission_deferred_until=clock_timestamp()
        where trigger_id=$1`,
      [quotaTriggerId],
    );
    await expect(
      scannerOne.scanDue({
        leaseOwner: 'recovery-scanner',
        limit: 10,
        leaseSeconds: 30,
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

  it('records skip atomically and supersedes a republished configuration without rewriting history', async () => {
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
    const disabledNext = await schedules.setEnabled({
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
    await schedules.setEnabled({
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
      reconciliation.reconcile({
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
  });

  it('lists only current schedule materializations and keeps command replay exact', async () => {
    const listed = await schedules.list({ workspaceId, actorId, workflowId });
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
    const first = await schedules.setEnabled(command);
    const replay = await schedules.setEnabled(command);
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
      schedules.setEnabled({
        ...command,
        enabled: true,
        requestHash: createHash('sha256').update('enable-main').digest('hex'),
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'ScheduleTriggerError',
    });
    await expect(
      schedules.list({
        workspaceId: randomUUID(),
        actorId,
        workflowId,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'ScheduleTriggerError',
    });

    const enabled = await schedules.setEnabled({
      ...command,
      enabled: true,
      idempotencyKey: 'enable-main',
      requestHash: createHash('sha256').update('enable-main').digest('hex'),
    });
    expect(enabled.trigger.nextFireAt).toEqual(first.trigger.nextFireAt);
  });
});
