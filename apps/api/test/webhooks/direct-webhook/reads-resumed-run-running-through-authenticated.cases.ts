import { expect, it } from 'vitest';

import { issueBrowserSession } from '../support/browser-session.fixture.js';

import {
  requireString,
  expectProblem,
  identityRuntime,
  service,
  application,
  verificationControl,
  workspaceId,
  seedWebhook,
  ownerQuery,
  apiQuery,
  durableCounts,
  withOneMoreDelivery,
  sendWebhook,
} from './fixture.js';

export function registerReadsResumedRunRunningThroughAuthenticated(): void {
  it('reads a resumed run as running through authenticated HTTP', async () => {
    const { actorId, endpointKey, originalSecret } =
      await seedWebhook('run-status-read');
    const accepted = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"status":"read"}', 'utf8'),
      'run-status-read',
    );
    expect(accepted.status).toBe(202);
    const runId = String(accepted.json.runId);
    const { cookieHeader } = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      actorId,
    );
    const read = () =>
      application.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/runs/${runId}`,
        headers: { cookie: cookieHeader },
      });
    await ownerQuery(
      `update app.workflow_runs set status='waiting' where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    const waiting = await read();
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json()).toMatchObject({
      run: { id: runId, status: 'waiting' },
    });
    await ownerQuery(
      `update app.workflow_runs set status='running' where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    const running = await read();
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      run: { id: runId, status: 'running' },
    });
  });

  it('rejects an authenticated malformed body with only a delivery-log fact', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('malformed');
    const beforeMalformed = await durableCounts();
    const malformed = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"valid-signature":"invalid-json"'),
      'malformed-json',
    );
    expectProblem(malformed, 400, 'webhook.invalid_json');
    expect(await durableCounts()).toEqual(withOneMoreDelivery(beforeMalformed));
  }, 60_000);

  it('honors the previous-secret overlap and exact expiry boundary', async () => {
    const { actorId, endpointKey, originalSecret, trigger, workflowId } =
      await seedWebhook('rotation');
    const rotated = await service.rotateSecret({
      workspaceId,
      workflowId,
      actorId,
      triggerId: trigger.id,
      endpointKey,
      idempotencyKey: 'direct-webhook-rotate-secret',
    });
    const currentSecret = requireString(rotated.signingSecret);
    const oldBoundary = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"rotation":"previous-valid"}'),
      'rotation-previous-valid',
    );
    expect(oldBoundary.status).toBe(202);
    const expired = await apiQuery(
      `update app.webhook_trigger_endpoints
        set previous_secret_valid_until=clock_timestamp()-interval '1 second'
        where workspace_id=$1 and workflow_id=$2 returning id`,
      [workspaceId, workflowId],
    );
    expect(expired.rowCount).toBe(1);
    const expiredPrevious = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"rotation":"previous-expired"}'),
      'rotation-previous-expired',
    );
    expectProblem(expiredPrevious, 401, 'webhook.authentication_failed');
    const currentBoundary = await sendWebhook(
      endpointKey,
      currentSecret,
      Buffer.from('{"rotation":"current-valid"}'),
      'rotation-current-valid',
    );
    expect(currentBoundary.status).toBe(202);
  }, 60_000);

  it('rolls back admission but records the throttled delivery when quota rejects it', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('quota');
    const accepted = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"quota":"baseline"}'),
      'quota-baseline',
    );
    expect(accepted.status).toBe(202);
    const queued = await ownerQuery<{ count: number }>(
      `select count(*)::int count from app.workflow_runs
        where workspace_id=$1 and status='queued'`,
      [workspaceId],
    );
    const queuedCount = queued.rows[0]?.count ?? 0;
    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
        (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,$2,'-infinity'::timestamptz)`,
      [workspaceId, queuedCount],
    );
    await ownerQuery(
      `update app.workspace_execution_entitlements set current_version=2
        where workspace_id=$1`,
      [workspaceId],
    );
    const beforeQuota = await durableCounts();
    const quota = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"quota":"rejected"}'),
      'quota-rejected',
    );
    expectProblem(quota, 429, 'webhook.rate_limited');
    expect(quota.headers['retry-after']).toBe('5');
    expect(await durableCounts()).toEqual(withOneMoreDelivery(beforeQuota));
  }, 60_000);

  it('keeps authentication material out of durable surfaces and queues references only', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('disclosure');
    const rawBody = Buffer.from(
      '{  "raw-byte-marker" : "payload-value", "nested" : {"ok":true} }\n',
      'utf8',
    );
    const first = await sendWebhook(
      endpointKey,
      originalSecret,
      rawBody,
      'disclosure-request',
    );
    expect(first.status).toBe(202);
    const nonInputDurableText =
      (
        await apiQuery<{ surface: string }>(
          `select string_agg(surface,E'\n') surface from (
          select to_jsonb(delivery)::text surface from app.webhook_trigger_deliveries delivery where workspace_id=$1
          union all select to_jsonb(replay)::text from app.webhook_trigger_replay_records replay where workspace_id=$1
          union all select to_jsonb(event)::text from app.run_events event where workspace_id=$1
          union all select to_jsonb(checkpoint)::text from app.run_checkpoints checkpoint where workspace_id=$1
          union all select to_jsonb(outbox)::text from app.outbox_events outbox where workspace_id=$1
        ) durable`,
          [workspaceId],
        )
      ).rows[0]?.surface ?? '';
    const runId = String(first.json.runId);
    const runRows = await apiQuery<{ input_ref: unknown; surface: string }>(
      `select input_ref,to_jsonb(run)::text surface
         from app.workflow_runs run where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    );
    expect(runRows.rows).toMatchObject([
      {
        input_ref: {
          kind: 'inline',
          value: {
            'raw-byte-marker': 'payload-value',
            nested: { ok: true },
          },
        },
      },
    ]);
    const signature = first.requestMaterial.signature;
    expect(nonInputDurableText).not.toContain(rawBody.toString('utf8'));
    const allDurableText = `${nonInputDurableText}\n${runRows.rows[0]?.surface ?? ''}`;
    expect(allDurableText).not.toContain(signature);
    expect(allDurableText).not.toContain(endpointKey);
    expect(allDurableText).not.toContain(originalSecret);
    const queuedPayloads = await apiQuery<{ payload: unknown }>(
      `select payload from app.outbox_events where workspace_id=$1
        and job_name='advance-workflow-run'`,
      [workspaceId],
    );
    expect(
      queuedPayloads.rows.every(({ payload }) => {
        const value = payload as Record<string, unknown>;
        return (
          Object.keys(value).sort().join(',') ===
          'outboxEventId,runId,workspaceId'
        );
      }),
    ).toBe(true);
  }, 60_000);

  it('maps an injected verification-adapter outage without claiming a database timeout', async () => {
    const { endpointKey, originalSecret } = await seedWebhook('outage');
    verificationControl.failVerification = true;
    try {
      const unavailable = await sendWebhook(
        endpointKey,
        originalSecret,
        Buffer.from('{"verification-adapter":"unavailable"}'),
        'verification-adapter-unavailable',
      );
      expectProblem(unavailable, 503, 'webhook.unavailable');
    } finally {
      verificationControl.failVerification = false;
    }
  }, 60_000);
}
