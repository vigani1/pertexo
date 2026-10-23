import type { QueryResultRow } from 'pg';

import { sendBoundedWebhook } from '../../support/bounded-client.js';
import type { HttpResponse } from './assertions.js';
import { apiPool, origin } from './lifecycle.js';
import { workspaceId } from './seed.js';

export function recordBenchmarkOperation(startedAt: number): void {
  if (process.env.PERTEXO_Q11_OPERATION_TIMING !== '1') return;
  const endedAt = performance.now();
  process.stdout.write(
    `PERTEXO_Q11_OPERATION=${JSON.stringify({ name: 'webhook-admit', startedAtUnixMs: performance.timeOrigin + startedAt, endedAtUnixMs: performance.timeOrigin + endedAt, population: 1, boundary: 'authenticated webhook request through durable admission response' })}\n`,
  );
}

export async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function durableCounts() {
  const result = await apiQuery<{
    deliveries: number;
    replay: number;
    runs: number;
  }>(
    `select
        (select count(*)::int from app.webhook_trigger_deliveries where workspace_id=$1) deliveries,
        (select count(*)::int from app.webhook_trigger_replay_records where workspace_id=$1) replay,
        (select count(*)::int from app.workflow_runs where workspace_id=$1) runs`,
    [workspaceId],
  );
  return result.rows[0];
}

export function withOneMoreDelivery(
  counts: Awaited<ReturnType<typeof durableCounts>>,
) {
  if (counts === undefined) throw new Error('Durable counts are missing');
  return { ...counts, deliveries: counts.deliveries + 1 };
}

export async function sendWebhook(
  endpointKey: string,
  secret: string,
  rawBody: Buffer,
  idempotencyKey: string,
): Promise<HttpResponse> {
  return sendBoundedWebhook({
    endpointKey,
    idempotencyKey,
    origin,
    rawBody,
    secret,
  });
}
