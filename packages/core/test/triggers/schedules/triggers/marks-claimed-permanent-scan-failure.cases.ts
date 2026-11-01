import {
  checkpointFactory,
  notificationDestinationId,
  notificationSecretVersionId,
  ownerQuery,
  triggerId,
  versionId,
  workflowId,
  workspaceId,
} from './fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import { checkDatabaseReadiness } from '@pertexo/database/primitives';
import { EXPECTED_MIGRATION_HEAD } from '@pertexo/database/testing';

import { schedule } from './fixture.js';

export function registerMarksClaimedPermanentScanFailure(): void {
  it('marks a claimed permanent scan failure degraded without advancing the occurrence', async () => {
    const failedTriggerId = randomUUID();
    const fingerprint = `trigger:sha256:${createHash('sha256').update(failedTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
         node_id,kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,'schedule-failed','schedule','active',$5::jsonb,$6,'healthy')`,
      [
        failedTriggerId,
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
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',1,'catch_up_once',$3,clock_timestamp()-interval '40 minutes',
         clock_timestamp()-interval '40 minutes')`,
      [failedTriggerId, workspaceId, fingerprint],
    );
    await expect(
      schedule.scannerOne.scanDue({
        leaseOwner: 'failed-scanner',
        limit: 1,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory: () => {
          throw new Error('permanent checkpoint failure');
        },
      }),
    ).rejects.toThrow('permanent checkpoint failure');
    await expect(
      ownerQuery(
        `select health_status,last_error_code,last_fire_at,next_fire_at<=clock_timestamp() due
           from app.trigger_schedules where trigger_id=$1`,
        [failedTriggerId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          health_status: 'degraded',
          last_error_code: 'schedule.scan_failed',
          last_fire_at: null,
          due: true,
        },
      ],
    });
    await ownerQuery(
      "update app.trigger_schedules set status='disabled' where trigger_id=$1",
      [failedTriggerId],
    );
  });

  it('records a due occurrence as paused, without a run, while the workflow is paused', async () => {
    const pausedTriggerId = randomUUID();
    const fingerprint = `trigger:sha256:${createHash('sha256').update(pausedTriggerId).digest('hex')}`;
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
         node_id,kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,'schedule-paused','schedule','active',$5::jsonb,$6,'healthy')`,
      [
        pausedTriggerId,
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
      `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
         interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
       values($1,$2,'interval',1,'catch_up_once',$3,clock_timestamp()-interval '50 minutes',
         clock_timestamp()-interval '50 minutes')`,
      [pausedTriggerId, workspaceId, fingerprint],
    );
    const pause = (state: 'paused' | 'none') =>
      ownerQuery(
        state === 'paused'
          ? `update app.workflows
                set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
                    trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
                    trigger_pause_last_run_id=gen_random_uuid(),
                    trigger_pause_revision=trigger_pause_revision+1
              where workspace_id=$1 and id=$2`
          : `update app.workflows
                set trigger_pause_state='none',trigger_paused_at=null,
                    trigger_pause_reason=null,trigger_pause_failures=null,
                    trigger_pause_last_run_id=null,
                    trigger_pause_revision=trigger_pause_revision+1
              where workspace_id=$1 and id=$2`,
        [workspaceId, workflowId],
      );
    await pause('paused');
    try {
      await expect(
        schedule.scannerOne.scanDue({
          leaseOwner: 'paused-scanner',
          limit: 1,
          leaseSeconds: 30,
          onTimeWindowSeconds: 300,
          checkpointFactory,
        }),
      ).resolves.toMatchObject({ claimed: 1, accepted: 0, paused: 1 });
      await expect(
        ownerQuery(
          `select occurrence.disposition,occurrence.workflow_run_id,
                  schedule.last_fire_at is not null fired,
                  schedule.next_fire_at>schedule.last_fire_at advanced
             from app.trigger_schedule_occurrences occurrence
             join app.trigger_schedules schedule on schedule.trigger_id=occurrence.trigger_id
            where occurrence.trigger_id=$1`,
          [pausedTriggerId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            disposition: 'paused',
            workflow_run_id: null,
            fired: true,
            advanced: true,
          },
        ],
      });
    } finally {
      await pause('none');
      await ownerQuery(
        "update app.trigger_schedules set status='disabled' where trigger_id=$1",
        [pausedTriggerId],
      );
    }
  });

  it('recovers an expired lease, excludes competing scanners, and commits one acceptance with outbox', async () => {
    await expect(
      checkDatabaseReadiness(schedule.worker),
    ).resolves.toMatchObject({
      migrationHead: EXPECTED_MIGRATION_HEAD,
      role: 'pertexo_app',
    });
    const crashed = await schedule.worker.query<{ trigger_id: string }>(
      'select * from app.claim_due_trigger_schedules($1,1,1)',
      ['crashed-scanner'],
    );
    expect(crashed.rowCount).toBe(1);
    await expect(
      schedule.scannerOne.scanDue({
        leaseOwner: 'blocked-scanner',
        limit: 1,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ claimed: 1, skipped: 1 });
    await ownerQuery(
      `update app.trigger_schedules
          set lease_acquired_at=clock_timestamp()-interval '2 seconds',
              lease_expires_at=clock_timestamp()-interval '1 second'
        where trigger_id=$1`,
      [crashed.rows[0]?.trigger_id],
    );
    const results = await Promise.all([
      schedule.scannerOne.scanDue({
        leaseOwner: 'scanner-one',
        limit: 10,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory,
      }),
      schedule.scannerTwo.scanDue({
        leaseOwner: 'scanner-two',
        limit: 10,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        checkpointFactory,
      }),
    ]);
    expect(results.reduce((total, result) => total + result.accepted, 0)).toBe(
      1,
    );
    const facts = await ownerQuery(
      `select occurrence.scheduled_at,run.id run_id,run.trigger_type,
               run.failure_notification_destination_id,
               run.failure_notification_destination_config_version,
               run.failure_notification_side_effect_class,
               run.failure_notification_connection_secret_version_id,
              exists(select 1 from app.outbox_events event where event.aggregate_id=run.id) has_outbox
         from app.trigger_schedule_occurrences occurrence
         join app.workflow_runs run on run.id=occurrence.workflow_run_id
        where occurrence.trigger_id=$1`,
      [triggerId],
    );
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]).toMatchObject({
      trigger_type: 'schedule',
      failure_notification_destination_id: notificationDestinationId,
      failure_notification_destination_config_version: 1,
      failure_notification_side_effect_class: 'idempotent_with_key',
      failure_notification_connection_secret_version_id:
        notificationSecretVersionId,
      has_outbox: true,
    });
  });
}
