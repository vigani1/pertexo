import {
  actorId,
  ownerQuery,
  skipTriggerId,
  triggerId,
  workflowId,
  workspaceId,
} from './fixture.js';
import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../../../src/outbox/events.repository.js';

import { schedule } from './fixture.js';

export function registerRecordsSkipSupersedesPublicationOperates(): void {
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
    const fingerprint = `trigger:sha256:${createHash('sha256').update(nextTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
         graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,2,'{"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,'{}'::jsonb,$5)`,
      [
        nextVersionId,
        workspaceId,
        workflowId,
        `wf:sha256:${'b'.repeat(64)}`,
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
      `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,
         aggregate_id,payload,payload_checksum)
       values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
      [
        outboxEventId,
        workspaceId,
        workflowId,
        JSON.stringify({
          workspaceId,
          outboxEventId,
          workflowId,
          publishedVersionId: nextVersionId,
        }),
        canonicalOutboxPayloadChecksum({
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
}
