import { createHmac, randomUUID } from 'node:crypto';

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { expect } from 'vitest';

import {
  adminBaseUrl,
  configuredDatabaseUrl,
  migrationBaseUrl,
} from '../fixture/environment.js';
import type { seedWebhook } from '../fixture.js';
import { apiPool, origin } from '../fixture.js';

export type Seeded = Awaited<ReturnType<typeof seedWebhook>>;

export function signatureOf(secret: string, timestamp: string, body: string) {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** What a sender can put on the wire; anything left out is left off the request. */
export async function send(
  endpointKey: string,
  {
    body = '{}',
    headers,
    secret,
    timestamp = String(nowSeconds()),
    idempotencyKey = randomUUID(),
  }: Readonly<{
    body?: string;
    headers?: Record<string, string>;
    secret?: string;
    timestamp?: string;
    idempotencyKey?: string;
  }>,
) {
  const response = await fetch(new URL(`/hooks/${endpointKey}`, origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      ...(secret === undefined
        ? {}
        : {
            'x-pertexo-timestamp': timestamp,
            'x-pertexo-signature': signatureOf(secret, timestamp, body),
          }),
      ...headers,
    },
    body,
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: (await response.json()) as Record<string, unknown>,
  };
}

export const deliver = (seeded: Seeded, body?: string) =>
  send(seeded.endpointKey, {
    secret: seeded.originalSecret,
    ...(body === undefined ? {} : { body }),
  });

/** Runs as the application role in that workspace, which sees its webhook rows. */
export async function inWorkspace<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
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

/** The rate limit table has no reader but its own function, so this looks as the superuser. */
export async function asSuperuser<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[],
) {
  const pool = new Pool({
    connectionString: configuredDatabaseUrl(adminBaseUrl),
    max: 1,
  });
  try {
    return await pool.query<Row>(statement, parameters);
  } finally {
    await pool.end();
  }
}

export async function traces({ workspaceId, workflowId }: Seeded) {
  const { rows } = await asSuperuser<{
    runs: number;
    accepted: number;
    rejected: number;
    spent: number;
  }>(
    `select
       (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,
       (select count(*)::int from app.webhook_trigger_deliveries
         where workspace_id=$2 and outcome='accepted') accepted,
       (select count(*)::int from app.webhook_trigger_deliveries
         where workspace_id=$2 and outcome<>'accepted') rejected,
       (select coalesce(sum(request_count),0)::int from app.webhook_endpoint_ingress_limits
         where workspace_id=$2) spent`,
    [workflowId, workspaceId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Delivery traces are unavailable');
  return row;
}

export const rejectedRows = async ({ workspaceId }: Seeded) =>
  (
    await inWorkspace<{ outcome: string; http_status: number }>(
      workspaceId,
      `select outcome,http_status from app.webhook_trigger_deliveries
        where workspace_id=$1 and outcome<>'accepted' order by received_at`,
      [workspaceId],
    )
  ).rows;

/** Only what differs between any two responses, whatever they answer. */
export function comparable({
  status,
  headers,
  body,
}: Awaited<ReturnType<typeof send>>) {
  const {
    date: _date,
    'x-request-id': _requestId,
    'keep-alive': _keepAlive,
    connection: _connection,
    ...stableHeaders
  } = headers;
  const { requestId: _bodyRequestId, ...stableBody } = body;
  return { status, headers: stableHeaders, body: stableBody };
}

export const endpointOf = async ({ workspaceId, workflowId }: Seeded) => {
  const { rows } = await inWorkspace<{
    id: string;
    endpoint_key_hash: string;
    current_secret_version_id: string;
    updated_at: Date;
  }>(
    workspaceId,
    `select id,endpoint_key_hash,current_secret_version_id,updated_at
       from app.webhook_trigger_endpoints where workflow_id=$1`,
    [workflowId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Endpoint row is missing');
  return row;
};

export const ADMISSION_ROW =
  'select 1 from app.workspace_execution_admission_counters where workspace_id=$1 for update';

export const PAUSE = `update app.workflows
    set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
        trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
        trigger_pause_last_run_id=(select id from app.workflow_runs where workflow_id=$1 limit 1),
        trigger_pause_revision=trigger_pause_revision+1
  where id=$1`;

/**
 * Another connection with a transaction left open, on a role that may write anything
 * these tests change, so the test decides when it commits.
 */
export async function holdRows(workspaceId: string) {
  const pool = new Pool({
    connectionString: configuredDatabaseUrl(migrationBaseUrl),
    max: 1,
  });
  const client: PoolClient = await pool.connect();
  await client.query('begin');
  await client.query('set local role pertexo_owner');
  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  const { rows } = await client.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const pid = rows[0]?.pid;
  let open = true;
  const waiting = async () => {
    const found = await asSuperuser<{ waiting: number }>(
      // Recursive: the second in line waits on the first, not on this transaction.
      `with recursive blocked(pid) as (
         select $1::int
         union
         select activity.pid from pg_stat_activity activity
           join blocked blocker on blocker.pid=any(pg_blocking_pids(activity.pid))
       ) select (count(*)-1)::int waiting from blocked`,
      [pid],
    );
    return found.rows[0]?.waiting ?? 0;
  };
  return {
    client,
    waiting,
    waitForWaiters: (count: number) =>
      expect
        .poll(waiting, { timeout: 4_000, interval: 20 })
        .toBeGreaterThanOrEqual(count),
    finish: async () => {
      if (!open) return;
      open = false;
      await client.query('commit');
      client.release();
      await pool.end();
    },
  };
}
