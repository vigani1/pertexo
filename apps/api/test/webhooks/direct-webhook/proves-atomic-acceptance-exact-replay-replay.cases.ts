import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { issueBrowserSession } from '../support/browser-session.fixture.js';

import {
  recordBenchmarkOperation,
  requireString,
  expectProblem,
  identity,
  identityRuntime,
  authoring,
  service,
  application,
  workspaceId,
  seedWebhook,
  ownerQuery,
  apiQuery,
  sendWebhook,
} from './fixture.js';

export function registerProvesAtomicAcceptanceExactReplayReplay(): void {
  it('proves atomic acceptance, exact replay, and replay conflict', async () => {
    const { actorId, endpointKey, originalSecret, trigger, workflowId } =
      await seedWebhook('atomic');

    const rawBody = Buffer.from(
      '{  "raw-byte-marker" : "payload-value", "nested" : {"ok":true} }\n',
      'utf8',
    );
    const key = 'sender-delivery-key';
    const operationStartedAt = performance.now();
    const first = await sendWebhook(endpointKey, originalSecret, rawBody, key);
    recordBenchmarkOperation(operationStartedAt);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ replayed: false });
    const runId = String(first.json.runId);
    const atomic = await apiQuery<{
      deliveries: number;
      runs: number;
      events: number;
      checkpoints: number;
      outbox: number;
    }>(
      `select
        (select count(*)::int from app.webhook_trigger_deliveries where workflow_run_id=$1) deliveries,
        (select count(*)::int from app.workflow_runs where id=$1 and status='queued' and trigger_type='webhook') runs,
        (select count(*)::int from app.run_events where workflow_run_id=$1 and sequence=1 and type='run.queued') events,
        (select count(*)::int from app.run_checkpoints where workflow_run_id=$1 and revision=0) checkpoints,
        (select count(*)::int from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run') outbox`,
      [runId],
    );
    expect(atomic.rows).toEqual([
      { deliveries: 1, runs: 1, events: 1, checkpoints: 1, outbox: 1 },
    ]);

    const replay = await sendWebhook(endpointKey, originalSecret, rawBody, key);
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual({ runId, replayed: true });
    const concurrent = await Promise.all([
      sendWebhook(endpointKey, originalSecret, rawBody, key),
      sendWebhook(endpointKey, originalSecret, rawBody, key),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([202, 202]);
    expect(concurrent.map(({ json }) => json)).toEqual([
      { runId, replayed: true },
      { runId, replayed: true },
    ]);
    const changed = await sendWebhook(
      endpointKey,
      originalSecret,
      Buffer.from('{"raw-byte-marker":"changed"}\n'),
      key,
    );
    expectProblem(changed, 409, 'webhook.idempotency_conflict');

    // ADR 045: each attributed request left one metadata-only delivery fact.
    const log = await service.listDeliveries({
      workspaceId,
      workflowId,
      actorId,
      triggerId: trigger.id,
    });

    expect(
      log.items.map(({ outcome, httpStatus, replayCheck, runId }) => [
        outcome,
        httpStatus,
        replayCheck,
        runId,
      ]),
    ).toEqual([
      ['conflict', 409, 'conflict', null],
      ['replayed', 202, 'duplicate', runId],
      ['replayed', 202, 'duplicate', runId],
      ['replayed', 202, 'duplicate', runId],
      ['accepted', 202, 'new', runId],
    ]);
    expect(log.items.at(-1)).toMatchObject({
      signatureCheck: 'verified',
      byteLength: rawBody.byteLength,
    });
    expect(log.nextCursor).toBeNull();
  }, 60_000);

  it('keeps a published public webhook accepting after its workflow becomes private', async () => {
    const seeded = await seedWebhook('restricted-published');
    const folderId = randomUUID(),
      readerId = randomUUID();
    await identity.createUser({
      id: readerId,
      email: `${readerId}@example.test`,
      displayName: 'Unshared reader',
    });
    await ownerQuery(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
      [seeded.workspaceId, readerId],
    );
    expect(
      await authoring.getWorkflow(
        seeded.workspaceId,
        seeded.workflowId,
        readerId,
      ),
    ).not.toBeNull();
    await ownerQuery(
      "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Private public trigger','private public trigger','restricted')",
      [seeded.workspaceId, folderId],
    );
    await ownerQuery(
      'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id,revision=app.workflow_organization_state.revision+1',
      [seeded.workspaceId, seeded.workflowId, folderId],
    );
    expect(
      await authoring.getWorkflow(
        seeded.workspaceId,
        seeded.workflowId,
        readerId,
      ),
    ).toBeNull();
    const accepted = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      Buffer.from('{"privateWorkflow":true}'),
      randomUUID(),
    );
    expect(accepted.status).toBe(202);
    expect(
      (
        await apiQuery(
          'select status,trigger_type from app.workflow_runs where id=$1',
          [String(accepted.json.runId)],
        )
      ).rows,
    ).toEqual([{ status: 'queued', trigger_type: 'webhook' }]);
  });

  it('returns 202 for signed and Secret URL concurrency skips, with durable native history and one usage fact', async () => {
    const seeded = await seedWebhook('concurrency-skip');
    const raw = Buffer.from('{"event":"skip proof"}');
    const first = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      raw,
      'concurrency-first',
    );
    expect(first.status).toBe(202);
    await ownerQuery(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
      [workspaceId, seeded.workflowId],
    );
    const signed = await sendWebhook(
      seeded.endpointKey,
      seeded.originalSecret,
      raw,
      'concurrency-signed',
    );
    expect(signed.status).toBe(202);
    expect(signed.json).toEqual({ skipped: true, reason: 'concurrency_limit' });
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seeded.actorId,
    );
    const policy = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/authentication`,
      headers: {
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'idempotency-key': randomUUID(),
      },
      payload: { mode: 'secret_url', allowedOrigins: [] },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    const key = requireString(
      policy.json<{ endpointKey: string }>().endpointKey,
    );
    const post = () =>
      application.inject({
        method: 'POST',
        url: `/hooks/${key}`,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'concurrency-url',
        },
        payload: raw,
      });
    const url = await post();
    expect(url.statusCode).toBe(202);
    expect(url.json()).toEqual({ skipped: true, reason: 'concurrency_limit' });
    expect((await post()).json()).toEqual(url.json());
    const history = await service.listDeliveries({
      workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: seeded.trigger.id,
    });
    expect(
      history.items.filter((item) => item.outcome === 'skipped'),
    ).toHaveLength(3);
    expect(
      (
        await ownerQuery(
          `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,(select count(*)::int from app.usage_events where resource_id=$1 and category='trigger.skipped') skips`,
          [seeded.workflowId],
        )
      ).rows,
    ).toEqual([{ runs: 1, skips: 2 }]);
  });
}
