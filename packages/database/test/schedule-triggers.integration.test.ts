import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalOutboxPayloadChecksum } from '../src/execution/outbox.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

const schedule = createScheduleTriggerTestEnvironment();
const {
  actorId,
  checkpointFactory,
  identity,
  notificationDestinationId,
  notificationSecretVersionId,
  operator,
  ownerQuery,
  replayStore,
  scannerOne,
  scannerTwo,
  triggerId,
  versionId,
  worker,
  workflowId,
  workspaceId,
} = schedule;
let replaySourceRunId = '';

beforeAll(async () => {
  replaySourceRunId = await schedule.initialize();
}, 60_000);
afterAll(schedule.close);

describe('schedule trigger PostgreSQL slice', () => {
  it('requests and worker-admits a replay with immutable lineage', async () => {
    await expect(
      operator.replayRun({
        actorRef: 'integration-operator',
        commandId: randomUUID(),
        dryRun: true,
        reason: 'inspect explicit replay',
        runInput: { explicit: 'operator-replay' },
        sourceRunId: replaySourceRunId,
        workflowVersionId: versionId,
        workspaceId,
      }),
    ).resolves.toMatchObject({
      outcome: 'would_request',
      replayed: false,
      status: 'completed',
    });
    const commandId = randomUUID();
    const command = {
      actorRef: 'integration-operator',
      commandId,
      dryRun: false,
      reason: 'replay after reconciled provider outcome',
      runInput: { explicit: 'operator-replay' },
      sourceRunId: replaySourceRunId,
      workflowVersionId: versionId,
      workspaceId,
    } as const;
    const requested = await operator.replayRun(command);
    expect(requested).toMatchObject({
      outcome: 'replay_requested',
      replayed: false,
      status: 'pending',
    });
    expect(await operator.replayRun(command)).toEqual({
      ...requested,
      replayed: true,
    });
    await expect(
      operator.replayRun({ ...command, runInput: { conflicting: true } }),
    ).rejects.toThrow('conflicts');

    const outboxEventId = requested.result.outboxEventId;
    expect(outboxEventId).toEqual(expect.any(String));
    const processed = await replayStore.replay({
      commandId,
      delivery: {
        outboxEventId: String(outboxEventId),
        payloadChecksum: canonicalOutboxPayloadChecksum({
          commandId,
          outboxEventId,
          schemaVersion: 1,
          workspaceId,
        }),
      },
      workspaceId,
    });
    expect(processed.kind).toBe('processed');
    expect(typeof processed.runId).toBe('string');
    const replayRunId = processed.runId;
    const lineage = await ownerQuery<{
      replay_command_id: string;
      replay_source_run_id: string;
      trigger_type: string;
      workflow_version_id: string;
    }>(
      `select replay_command_id,replay_source_run_id,trigger_type,workflow_version_id
       from app.workflow_runs where id=$1`,
      [replayRunId],
    );
    expect(lineage.rows[0]).toEqual({
      replay_command_id: commandId,
      replay_source_run_id: replaySourceRunId,
      trigger_type: 'replay',
      workflow_version_id: versionId,
    });
    const completed = await operator.getCommand({
      actorRef: 'integration-operator',
      commandId,
      reason: 'verify replay completion',
      workspaceId,
    });
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed).toMatchObject({
      outcome: 'replay_created',
      status: 'completed',
      result: { resultRunId: replayRunId },
    });
    await ownerQuery(
      `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
       where id=$1`,
      [replayRunId],
    );
  });

  it('dry-runs and exactly replays a fresh operator reconciliation request', async () => {
    const dryRun = await operator.retryTriggerReconciliation({
      actorRef: 'integration-operator',
      commandId: randomUUID(),
      dryRun: true,
      reason: 'inspect trigger reconciliation retry',
      workflowId,
      workspaceId,
    });
    expect(dryRun).toMatchObject({ outcome: 'would_retry', replayed: false });

    const command = {
      actorRef: 'integration-operator',
      commandId: randomUUID(),
      dryRun: false,
      reason: 'retry trigger reconciliation after provider recovery',
      workflowId,
      workspaceId,
    } as const;
    const first = await operator.retryTriggerReconciliation(command);
    const replay = await operator.retryTriggerReconciliation(command);
    expect(first).toMatchObject({
      outcome: 'retry_requested',
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });

    const outboxEventId = first.result.outboxEventId;
    expect(outboxEventId).toEqual(expect.any(String));
    const event = await ownerQuery<{
      job_name: string;
      payload: Record<string, unknown>;
      payload_checksum: string;
    }>(
      `select job_name,payload,payload_checksum from app.outbox_events where id=$1`,
      [outboxEventId],
    );
    expect(event.rows[0]).toMatchObject({
      job_name: 'reconcile-workflow-triggers',
      payload: {
        outboxEventId,
        publishedVersionId: versionId,
        schemaVersion: 1,
        workflowId,
        workspaceId,
      },
    });
    expect(event.rows[0]?.payload_checksum).toBe(
      canonicalOutboxPayloadChecksum(event.rows[0]?.payload),
    );
  });

  it('admits one due schedule per workspace and backoff prevents limit-one starvation', async () => {
    const otherWorkspaceId = randomUUID();
    const otherWorkflowId = randomUUID();
    const otherVersionId = randomUUID();
    const oldestTriggerId = randomUUID();
    const otherTriggerId = randomUUID();
    await identity.createWorkspaceWithOwner({
      id: otherWorkspaceId,
      name: 'Other Schedule Workspace',
      slug: `schedule-other-${otherWorkspaceId}`,
      ownerUserId: actorId,
      idempotencyKey: `schedule-other-${otherWorkspaceId}`,
    });
    await ownerQuery(
      `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,
         published_version_id,created_by) values($1,$2,'Other','active','active',null,$3)`,
      [otherWorkflowId, otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
    await ownerQuery(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,
         schema_version,graph_json,checksum,executable_schema_version,executable_json,
         compatibility_release_epoch,published_by)
       values($1,$2,$3,1,1,'{"schemaVersion":1,"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,2,'{}'::jsonb,1,$5)`,
      [
        otherVersionId,
        otherWorkspaceId,
        otherWorkflowId,
        `wf:v2:sha256:${'b'.repeat(64)}`,
        actorId,
      ],
      otherWorkspaceId,
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [otherWorkflowId, otherVersionId],
      otherWorkspaceId,
    );
    for (const [id, scopedWorkspace, workflow, version, age] of [
      [oldestTriggerId, workspaceId, workflowId, versionId, '30 minutes'],
      [
        otherTriggerId,
        otherWorkspaceId,
        otherWorkflowId,
        otherVersionId,
        '20 minutes',
      ],
    ] as const) {
      const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(id).digest('hex')}`;
      await ownerQuery(
        `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
           node_id,kind,status,desired_config,config_fingerprint,health_status)
         values($1,$2,$3,$4,$5,'schedule','active',$6::jsonb,$7,'healthy')`,
        [
          id,
          scopedWorkspace,
          workflow,
          version,
          `fair-${id}`,
          JSON.stringify({
            kind: 'interval',
            intervalMinutes: 1,
            misfirePolicy: 'catch_up_once',
          }),
          fingerprint,
        ],
        scopedWorkspace,
      );
      await ownerQuery(
        `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
           interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
         values($1,$2,'interval',1,'catch_up_once',$3,clock_timestamp()-$4::interval,
           clock_timestamp()-$4::interval)`,
        [id, scopedWorkspace, fingerprint, age],
        scopedWorkspace,
      );
    }
    const first = await worker.query<{
      trigger_id: string;
      lease_token: string;
    }>(
      `select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)`,
      ['fairness-one'],
    );
    expect(first.rows[0]?.trigger_id).toBe(oldestTriggerId);
    await worker.query('select app.defer_trigger_schedule_claim($1,$2,5)', [
      oldestTriggerId,
      first.rows[0]?.lease_token,
    ]);
    const second = await worker.query<{
      trigger_id: string;
      lease_token: string;
    }>(
      `select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)`,
      ['fairness-two'],
    );
    expect(second.rows[0]?.trigger_id).toBe(otherTriggerId);
    await worker.query('select app.release_trigger_schedule_claim($1,$2)', [
      otherTriggerId,
      second.rows[0]?.lease_token,
    ]);
    await ownerQuery(
      "update app.trigger_schedules set status='disabled' where trigger_id=$1",
      [oldestTriggerId],
    );
    await ownerQuery(
      "update app.trigger_schedules set status='disabled' where trigger_id=$1",
      [otherTriggerId],
      otherWorkspaceId,
    );
  });

  it('marks a claimed permanent scan failure degraded without advancing the occurrence', async () => {
    const failedTriggerId = randomUUID();
    const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(failedTriggerId).digest('hex')}`;
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
      scannerOne.scanDue({
        leaseOwner: 'failed-scanner',
        limit: 1,
        leaseSeconds: 30,
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

  it('recovers an expired lease, excludes competing scanners, and commits one acceptance with outbox', async () => {
    await expect(checkDatabaseReadiness(worker)).resolves.toMatchObject({
      migrationHead: '0077_replay_read_locks.sql',
      role: 'pertexo_worker',
    });
    const crashed = await worker.query<{ trigger_id: string }>(
      'select * from app.claim_due_trigger_schedules($1,1,1)',
      ['crashed-scanner'],
    );
    expect(crashed.rowCount).toBe(1);
    await expect(
      scannerOne.scanDue({
        leaseOwner: 'blocked-scanner',
        limit: 1,
        leaseSeconds: 30,
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
      scannerOne.scanDue({
        leaseOwner: 'scanner-one',
        limit: 10,
        leaseSeconds: 30,
        checkpointFactory,
      }),
      scannerTwo.scanDue({
        leaseOwner: 'scanner-two',
        limit: 10,
        leaseSeconds: 30,
        checkpointFactory,
      }),
    ]);
    expect(results.reduce((total, result) => total + result.accepted, 0)).toBe(
      1,
    );
    const facts = await ownerQuery(
      `select occurrence.scheduled_at,run.id run_id,run.trigger_type,
               run.failure_notification_policy_version,
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
      failure_notification_policy_version: 1,
      failure_notification_destination_id: notificationDestinationId,
      failure_notification_destination_config_version: 1,
      failure_notification_side_effect_class: 'idempotent_with_key',
      failure_notification_connection_secret_version_id:
        notificationSecretVersionId,
      has_outbox: true,
    });
  });
});
