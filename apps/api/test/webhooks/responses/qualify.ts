import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  registerWebhookIngress,
  type WebhookIngressDependencies,
} from '../../../src/webhooks/ingress.js';
import { createWebhookResponseWaiter } from '../../../src/webhooks/responses/wait.js';
import { sendBoundedWebhook, signatureFor } from '../support/bounded-client.js';

type Seed = Readonly<{
  workspaceId: string;
  workflowId: string;
  endpointKey: string;
  originalSecret: string;
}>;
type Qualification = Readonly<{
  ingress: WebhookIngressDependencies;
  seed: (label: string, config: Record<string, unknown>) => Promise<Seed>;
  query: <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ) => Promise<QueryResult<Row>>;
}>;
export async function qualifyWebhookResponseWaiting({
  ingress,
  seed,
  query,
}: Qualification) {
  const applications: FastifyInstance[] = [];
  const requests: Promise<unknown>[] = [];
  const disconnected = new AbortController();
  async function listen() {
    const app = Fastify();
    applications.push(app);
    registerWebhookIngress(app, ingress);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Response listener unavailable');
    return { app, origin: `http://127.0.0.1:${String(address.port)}` };
  }
  async function acceptedRun(workflowId: string) {
    let id: string | undefined;
    await expect
      .poll(async () => {
        id = (
          await query<{ id: string }>(
            'select id from app.workflow_runs where workflow_id=$1 order by created_at limit 1',
            [workflowId],
          )
        ).rows[0]?.id;
        return id !== undefined;
      })
      .toBe(true);
    if (id === undefined) throw new Error('Accepted response run missing');
    return id;
  }
  try {
    const first = await listen(),
      second = await listen();
    const active = await seed('response-replicas', {
      responseMode: 'workflow',
      responseWaitSeconds: 3,
    });
    const key = randomUUID();
    const send = (origin: string, s = active, k = key) =>
      sendBoundedWebhook({
        origin,
        endpointKey: s.endpointKey,
        secret: s.originalSecret,
        idempotencyKey: k,
        rawBody: Buffer.from('{}'),
      });
    const replies = Promise.all([send(first.origin), send(second.origin)]);
    requests.push(replies);
    void replies.catch(() => undefined);
    const runId = await acceptedRun(active.workflowId);
    // A committed worker result is the only input these independent API listeners share.
    await query(
      `update app.webhook_run_responses set status_code=201,content_type='application/json',headers='{"x-request-id":"durable-response"}'::jsonb,body='{"accepted":true}',node_run_id=$2,invocation_key='fixture-response',responded_at=clock_timestamp() where run_id=$1`,
      [runId, randomUUID()],
    );
    for (const reply of await replies) {
      expect(reply.status).toBe(201);
      expect(reply.json).toEqual({ accepted: true });
      expect(reply.headers).toMatchObject({
        'x-request-id': 'durable-response',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    }
    expect(
      (
        await query<{ count: number }>(
          'select count(*)::int count from app.workflow_runs where workflow_id=$1',
          [active.workflowId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    await first.app.close();
    const restarted = await listen();
    expect((await send(restarted.origin)).json).toEqual({ accepted: true });
    const timed = await seed('response-timeout', {
      responseMode: 'workflow',
      responseWaitSeconds: 1,
    });
    const timeout = await send(second.origin, timed, randomUUID());
    expect(timeout.status).toBe(202);
    const timedId = String(timeout.json.runId);
    expect(
      (
        await query<{ status: string }>(
          'select status from app.workflow_runs where id=$1',
          [timedId],
        )
      ).rows,
    ).toEqual([{ status: 'queued' }]);
    let reads = 0;
    const waiter = createWebhookResponseWaiter(async (input) => {
      reads++;
      return ingress.database.readResponse(input);
    });
    try {
      const scope = {
        workspaceId: timed.workspaceId,
        runId: timedId,
        seconds: 1,
        signal: new AbortController().signal,
      };
      const waits = Array.from({ length: 32 }, () => waiter.wait(scope));
      expect(await waiter.wait(scope)).toBeNull();
      expect(await Promise.all(waits)).toEqual(
        Array.from({ length: 32 }, () => null),
      );
      expect(reads).toBeLessThanOrEqual(128);
      expect(reads).toBeGreaterThanOrEqual(32);
      console.info(
        `Webhook wait qualification: 32 waits, ${String(reads)} indexed reads in a one-second budget; overflow returned immediately.`,
      );
    } finally {
      waiter.close();
    }
    const failed = await seed('response-failed', {
      responseMode: 'workflow',
      responseWaitSeconds: 3,
    });
    const failure = send(second.origin, failed, randomUUID());
    requests.push(failure);
    void failure.catch(() => undefined);
    const failedId = await acceptedRun(failed.workflowId);
    await query(
      "update app.workflow_runs set status='failed',started_at=clock_timestamp(),completed_at=clock_timestamp(),error_summary='private provider message' where id=$1",
      [failedId],
    );
    const failureReply = await failure;
    expect(failureReply.status).toBe(500);
    expect(failureReply.json).toEqual({ code: 'webhook.workflow_failed' });
    const gone = await seed('response-disconnect', {
      responseMode: 'workflow',
      responseWaitSeconds: 3,
    });
    const body = Buffer.from('{}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const aborting = fetch(
      new URL(`/hooks/${gone.endpointKey}`, second.origin),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
          'x-pertexo-timestamp': timestamp,
          'x-pertexo-signature': signatureFor(
            gone.originalSecret,
            timestamp,
            body,
          ),
        },
        body,
        signal: disconnected.signal,
      },
    );
    requests.push(aborting);
    void aborting.catch(() => undefined);
    const goneId = await acceptedRun(gone.workflowId);
    disconnected.abort();
    await expect(aborting).rejects.toThrow();
    expect(
      (
        await query<{ status: string; cancel_requested_at: Date | null }>(
          'select status,cancel_requested_at from app.workflow_runs where id=$1',
          [goneId],
        )
      ).rows,
    ).toEqual([{ status: 'queued', cancel_requested_at: null }]);
  } finally {
    disconnected.abort();
    await Promise.allSettled(applications.map((app) => app.close()));
    await Promise.allSettled(requests);
  }
}
