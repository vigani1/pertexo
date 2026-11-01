import {
  actorId,
  ownerQuery,
  versionId,
  workflowId,
  workspaceId,
} from './fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';

import { schedule } from './fixture.js';

export function registerDryRunsExactlyReplaysFresh(): void {
  it('dry-runs and exactly replays a fresh operator reconciliation request', async () => {
    const dryRun = await schedule.operator.retryTriggerReconciliation({
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
    const first = await schedule.operator.retryTriggerReconciliation(command);
    const replay = await schedule.operator.retryTriggerReconciliation(command);
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
    await schedule.identity.createWorkspaceWithOwner({
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
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}'::jsonb,
         $4,'{}'::jsonb,$5)`,
      [
        otherVersionId,
        otherWorkspaceId,
        otherWorkflowId,
        `wf:sha256:${'b'.repeat(64)}`,
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
      const fingerprint = `trigger:sha256:${createHash('sha256').update(id).digest('hex')}`;
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
    const first = await schedule.worker.query<{
      trigger_id: string;
      lease_token: string;
    }>(
      `select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)`,
      ['fairness-one'],
    );
    expect(first.rows[0]?.trigger_id).toBe(oldestTriggerId);
    await expect(
      schedule.worker.query(
        'select app.defer_trigger_schedule_claim($1,$2,null)',
        [oldestTriggerId, first.rows[0]?.lease_token],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      ownerQuery<{
        admission_deferred_until: Date | null;
        lease_token: string | null;
      }>(
        `select lease_token::text,admission_deferred_until
           from app.trigger_schedules where trigger_id=$1`,
        [oldestTriggerId],
        workspaceId,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          admission_deferred_until: null,
          lease_token: first.rows[0]?.lease_token,
        },
      ],
    });
    await schedule.worker.query(
      'select app.defer_trigger_schedule_claim($1,$2,5)',
      [oldestTriggerId, first.rows[0]?.lease_token],
    );
    const second = await schedule.worker.query<{
      trigger_id: string;
      lease_token: string;
    }>(
      `select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)`,
      ['fairness-two'],
    );
    expect(second.rows[0]?.trigger_id).toBe(otherTriggerId);
    await schedule.worker.query(
      'select app.release_trigger_schedule_claim($1,$2)',
      [otherTriggerId, second.rows[0]?.lease_token],
    );
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
}
