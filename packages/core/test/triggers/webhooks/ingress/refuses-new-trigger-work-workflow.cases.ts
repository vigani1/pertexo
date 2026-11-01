import { webhookRunInput } from '@pertexo/nodes-core';

import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  WebhookDeliveryIneligibleError,
  WebhookWorkflowPausedError,
} from '../../../../src/triggers/webhooks/errors.js';

import {
  actorId,
  workspaceId,
  hash,
  post,
  acceptWebhook,
  authoring,
  ownerQuery,
  pausedNow,
  workerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';

export function registerRefusesNewTriggerWorkWorkflow(): void {
  it('refuses new trigger work while the workflow is paused, still answering replays', async () => {
    const { published, resources, verification } =
      await createWebhookScenario();
    const pausedWorkflowId = published.created.workflowId;
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('before-pause'),
      idempotencyKeyHash: hash('before-pause-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'before-pause' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    const before = await acceptWebhook(input);
    // ADR 056: the fold records a pause exactly like this.
    await ownerQuery(
      `update app.workflows
          set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
              trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
              trigger_pause_last_run_id=$3,
              trigger_pause_revision=trigger_pause_revision+1
        where workspace_id=$1 and id=$2`,
      [workspaceId, pausedWorkflowId, before.runId],
    );

    await expect(acceptWebhook(input)).resolves.toEqual({
      runId: before.runId,
      replayed: true,
    });
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('during-pause'),
        idempotencyKeyHash: hash('during-pause-key'),
        runInput: { event: 'during-pause' },
      }),
    ).rejects.toBeInstanceOf(WebhookWorkflowPausedError);
    const runs = await ownerQuery<{ count: number }>(
      `select count(*)::int as count from app.workflow_runs
        where workspace_id=$1 and workflow_id=$2`,
      [workspaceId, pausedWorkflowId],
    );
    expect(runs.rows).toEqual([{ count: 1 }]);

    await ownerQuery(
      `update app.trigger_schedules set next_fire_at=clock_timestamp()-interval '1 minute'
         where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, resources.scheduleId],
    );
    const claimed = await workerQuery<{
      lease_token: string;
      trigger_id: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`pause-gate-${randomUUID()}`],
    );
    const claim = claimed.rows[0];
    if (claim === undefined) throw new Error('Paused schedule claim missing');
    expect(claim.trigger_id).toBe(resources.scheduleId);
    await expect(pausedNow(claim)).resolves.toBe(true);
    await workerQuery('select app.release_trigger_schedule_claim($1,$2)', [
      claim.trigger_id,
      claim.lease_token,
    ]);
    const controls = authoring.autoPause;
    if (controls === undefined) throw new Error('Auto pause controls missing');
    const scope = { workspaceId, workflowId: pausedWorkflowId, actorId };
    await controls.resumeWorkflow({
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    });
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('after-resume'),
        idempotencyKeyHash: hash('after-resume-key'),
        runInput: { event: 'after-resume' },
      }),
    ).resolves.toMatchObject({ replayed: false });
    const resumedClaim = await workerQuery<{
      trigger_id: string;
      lease_token: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`resume-gate-${randomUUID()}`],
    );
    const resumed = resumedClaim.rows[0];
    if (resumed === undefined)
      throw new Error('Resumed schedule claim missing');
    expect(resumed.trigger_id).toBe(resources.scheduleId);
    await expect(pausedNow(resumed)).resolves.toBe(false);
    await workerQuery('select app.release_trigger_schedule_claim($1,$2)', [
      resumed.trigger_id,
      resumed.lease_token,
    ]);

    // A person's disabled resources remain disabled through pause, archive,
    // restore and resume. Only the separate pause state is cleared.
    await workerQuery(
      "update app.webhook_trigger_endpoints set status='disabled' where id=$1",
      [resources.endpointId],
    );
    await ownerQuery(
      "update app.workflow_triggers set status='disabled',health_status='disabled' where workflow_version_id=(select published_version_id from app.workflows where id=(select workflow_id from app.webhook_trigger_endpoints where id=$1)) and node_id=(select node_id from app.webhook_trigger_endpoints where id=$1)",
      [resources.endpointId],
    );
    await ownerQuery(
      "update app.trigger_schedules set status='disabled' where trigger_id=$1",
      [resources.scheduleId],
    );
    await ownerQuery(
      `update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
      trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,trigger_pause_last_run_id=$3,
      trigger_pause_revision=trigger_pause_revision+1 where workspace_id=$1 and id=$2`,
      [workspaceId, pausedWorkflowId, before.runId],
    );
    await authoring.transitionWorkflowLifecycle({
      ...scope,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await authoring.transitionWorkflowLifecycle({
      ...scope,
      command: 'restore',
      expectedLifecycleRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect((await controls.readWorkflowSettings(scope)).pauseState).toBe(
      'paused',
    );
    await controls.resumeWorkflow({
      ...scope,
      expectedPauseRevision: '4',
      idempotencyKey: randomUUID(),
    });
    await expect(
      ownerQuery(
        `select endpoint.status as endpoint_status,schedule.status as schedule_status
      from app.webhook_trigger_endpoints endpoint join app.trigger_schedules schedule on schedule.trigger_id=$2
      where endpoint.id=$1`,
        [resources.endpointId, resources.scheduleId],
      ),
    ).resolves.toMatchObject({
      rows: [{ endpoint_status: 'disabled', schedule_status: 'disabled' }],
    });
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('still-disabled'),
        idempotencyKeyHash: hash('still-disabled-key'),
        runInput: { event: 'still-disabled' },
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
  });
}
