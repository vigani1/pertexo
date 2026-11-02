import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { expect, it } from 'vitest';

import { issueBrowserSession } from '../support/browser-session.fixture.js';
import {
  adminBaseUrl,
  configuredDatabaseUrl,
  migrationBaseUrl,
} from './fixture/environment.js';
import {
  application,
  apiPool,
  identityRuntime,
  origin,
  ownerQuery,
  seedWebhook,
  service,
} from './fixture.js';
import { publishAndReconcile } from './publish-flow.js';

type Seeded = Awaited<ReturnType<typeof seedWebhook>>;

function signatureOf(secret: string, timestamp: string, body: string) {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** What a sender can put on the wire; anything left out is left off the request. */
async function send(
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

const deliver = (seeded: Seeded, body?: string) =>
  send(seeded.endpointKey, {
    secret: seeded.originalSecret,
    ...(body === undefined ? {} : { body }),
  });

/** Runs as the application role in that workspace, which sees its webhook rows. */
async function inWorkspace<Row extends QueryResultRow = QueryResultRow>(
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
async function asSuperuser<Row extends QueryResultRow = QueryResultRow>(
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

async function traces({ workspaceId, workflowId }: Seeded) {
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

const rejectedRows = async ({ workspaceId }: Seeded) =>
  (
    await inWorkspace<{ outcome: string; http_status: number }>(
      workspaceId,
      `select outcome,http_status from app.webhook_trigger_deliveries
        where workspace_id=$1 and outcome<>'accepted' order by received_at`,
      [workspaceId],
    )
  ).rows;

/** Only what differs between any two responses, whatever they answer. */
function comparable({
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

const endpointOf = async ({ workspaceId, workflowId }: Seeded) => {
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

const ADMISSION_ROW =
  'select 1 from app.workspace_execution_admission_counters where workspace_id=$1 for update';

const PAUSE = `update app.workflows
    set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
        trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
        trigger_pause_last_run_id=(select id from app.workflow_runs where workflow_id=$1 limit 1),
        trigger_pause_revision=trigger_pause_revision+1
  where id=$1`;

const CLOSED_DOORS: readonly (readonly [
  string,
  (seeded: Seeded) => Promise<unknown>,
])[] = [
  [
    'a disabled endpoint',
    ({ workspaceId, workflowId }) =>
      inWorkspace(
        workspaceId,
        "update app.webhook_trigger_endpoints set status='disabled' where workflow_id=$1",
        [workflowId],
      ),
  ],
  [
    'an archived workflow',
    ({ workflowId }) =>
      ownerQuery(
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [workflowId],
      ),
  ],
  [
    'a suspended workspace',
    ({ workspaceId }) =>
      ownerQuery("update app.workspaces set status='suspended' where id=$1", [
        workspaceId,
      ]),
  ],
  [
    'a workspace pending deletion',
    ({ workspaceId, actorId }) =>
      ownerQuery(
        `update app.workspaces set status='pending_deletion',
           deletion_requested_at=clock_timestamp(),deletion_requested_by=$2,
           deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
        [workspaceId, actorId],
      ),
  ],
  [
    'a publish that removed the step',
    (seeded) =>
      publishAndReconcile(seeded, {
        settings: {},
        nodes: [
          {
            id: 'finish',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
      }),
  ],
];

export function registerClosedDoors(): void {
  it.each(CLOSED_DOORS)(
    'answers %s exactly as an unknown address: 401, no delivery row, no limit spent',
    async (_name, close) => {
      const seeded = await seedWebhook(`closed-${randomUUID()}`);
      expect((await deliver(seeded)).status).toBe(202);
      await close(seeded);
      const before = await traces(seeded);
      expect(before.spent).toBe(1);

      const closed = await deliver(seeded);
      const unknown = await send(randomBytes(32).toString('base64url'), {
        secret: seeded.originalSecret,
      });

      expect(closed.status).toBe(401);
      expect(closed.body).toMatchObject({
        code: 'webhook.authentication_failed',
      });
      expect(comparable(closed)).toEqual(comparable(unknown));
      expect(await traces(seeded)).toEqual(before);
    },
    60_000,
  );

  it('tells a paused workflow only to a sender who proved the signature', async () => {
    const seeded = await seedWebhook(`paused-${randomUUID()}`);
    expect((await deliver(seeded)).status).toBe(202);
    await ownerQuery(PAUSE, [seeded.workflowId]);
    const unsigned = await send(seeded.endpointKey, {});
    const unknown = await send(randomBytes(32).toString('base64url'), {});
    expect(comparable(unsigned)).toEqual(comparable(unknown));

    const before = await traces(seeded);
    const signed = await deliver(seeded);
    expect(signed.status).toBe(423);
    expect(signed.body).toMatchObject({ code: 'webhook.workflow_paused' });
    expect((await traces(seeded)).runs).toBe(before.runs);
  }, 60_000);

  it.each([
    [
      'an archive',
      "update app.workflows set lifecycle_status='archived' where id=$1",
      401,
    ],
    ['a pause', PAUSE, 423],
  ] as const)(
    'refuses a sender waiting on the lock while %s commits, and starts nothing',
    async (_name, statement, status) => {
      const seeded = await seedWebhook(`wait-${randomUUID()}`);
      expect((await deliver(seeded)).status).toBe(202);
      const before = await traces(seeded);
      const holder = await holdRows(seeded.workspaceId);
      try {
        await holder.client.query(statement, [seeded.workflowId]);
        const waiting = deliver(seeded);
        await holder.waitForWaiters(1);
        await holder.finish();
        const answered = await waiting;
        expect(answered.status).toBe(status);
        expect(await traces(seeded)).toEqual({
          ...before,
          // The sender proved itself, so its attempt is on the owner's log (ADR 045).
          rejected: before.rejected + 1,
          spent: before.spent + 1,
        });
        expect(await rejectedRows(seeded)).toMatchObject([
          { http_status: status },
        ]);
      } finally {
        await holder.finish();
      }
    },
    60_000,
  );

  it('refuses a signature that is wrong, old, from the future, missing or for other bytes', async () => {
    const seeded = await seedWebhook(`signature-${randomUUID()}`);
    const key = seeded.endpointKey;
    const secret = seeded.originalSecret;
    const before = await traces(seeded);
    const timestamp = String(nowSeconds());
    const attempts: readonly (readonly [string, Parameters<typeof send>[1]])[] =
      [
        ['no proof at all', {}],
        ['a wrong secret', { secret: randomBytes(32).toString('base64url') }],
        [
          'a captured request from an hour ago',
          {
            secret,
            timestamp: String(nowSeconds() - 3_600),
          },
        ],
        [
          'one just past the five minute allowance',
          {
            secret,
            timestamp: String(nowSeconds() - 310),
          },
        ],
        [
          'a timestamp from the future',
          {
            secret,
            timestamp: String(nowSeconds() + 3_600),
          },
        ],
        [
          'a signature without its timestamp',
          {
            headers: {
              'x-pertexo-signature': signatureOf(secret, timestamp, '{}'),
            },
          },
        ],
        [
          'a timestamp without its signature',
          {
            headers: { 'x-pertexo-timestamp': timestamp },
          },
        ],
        [
          'a signature over other bytes',
          {
            body: '{"amount":1000000}',
            headers: {
              'x-pertexo-timestamp': timestamp,
              'x-pertexo-signature': signatureOf(secret, timestamp, '{}'),
            },
          },
        ],
        [
          'a signature in the wrong scheme',
          {
            headers: {
              'x-pertexo-timestamp': timestamp,
              'x-pertexo-signature': signatureOf(
                secret,
                timestamp,
                '{}',
              ).replace('v1=', 'v0='),
            },
          },
        ],
      ];
    const reference = comparable(await send(key, {}));
    expect(reference.status).toBe(401);
    for (const [name, attempt] of attempts) {
      const answered = comparable(await send(key, attempt));
      expect(answered, name).toEqual(reference);
    }
    const after = await traces(seeded);
    expect(after.runs).toBe(before.runs);
    expect(after.accepted).toBe(before.accepted);
    expect(
      (await rejectedRows(seeded)).map(({ http_status }) => http_status),
    ).toEqual(Array.from({ length: attempts.length + 1 }, () => 401));
  }, 60_000);

  it('answers a replayed request once: same key returns the first run, other bytes conflict', async () => {
    const seeded = await seedWebhook(`replay-${randomUUID()}`);
    const idempotencyKey = randomUUID();
    const first = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
    });
    expect(first.status).toBe(202);
    const replayed = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
    });
    expect(replayed.status).toBe(202);
    expect(replayed.body).toMatchObject({
      runId: first.body.runId,
      replayed: true,
    });
    const changed = await send(seeded.endpointKey, {
      secret: seeded.originalSecret,
      idempotencyKey,
      body: '{"other":true}',
    });
    expect(changed.status).toBe(409);
    expect((await traces(seeded)).runs).toBe(1);
  }, 60_000);

  it('takes the previous secret inside its window and not a moment after', async () => {
    const seeded = await seedWebhook(`window-${randomUUID()}`);
    const rotated = await service.rotateSecret({
      workspaceId: seeded.workspaceId,
      workflowId: seeded.workflowId,
      actorId: seeded.actorId,
      triggerId: seeded.trigger.id,
      endpointKey: seeded.endpointKey,
      idempotencyKey: randomUUID(),
    });
    const next = rotated.signingSecret;
    if (next === undefined) throw new Error('Expected the next secret');
    expect((await deliver(seeded)).status).toBe(202);
    await inWorkspace(
      seeded.workspaceId,
      `update app.webhook_trigger_endpoints
          set previous_secret_valid_until=clock_timestamp()-interval '1 millisecond'
        where workflow_id=$1`,
      [seeded.workflowId],
    );
    const before = await traces(seeded);
    expect((await deliver(seeded)).status).toBe(401);
    expect((await traces(seeded)).runs).toBe(before.runs);
    expect((await send(seeded.endpointKey, { secret: next })).status).toBe(202);
  }, 60_000);

  it('lets three deliveries of a busy workspace on the database at a time, the fourth waiting off it, and accepts them all', async () => {
    const seeded = await seedWebhook(`turns-${randomUUID()}`);
    const holder = await holdRows(seeded.workspaceId);
    try {
      await holder.client.query(ADMISSION_ROW, [seeded.workspaceId]);
      const line = Array.from({ length: 4 }, () => deliver(seeded));
      await holder.waitForWaiters(3);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await holder.waiting()).toBe(3);
      await holder.finish();
      const answers = await Promise.all(line);
      expect(answers.map(({ status }) => status)).toEqual([202, 202, 202, 202]);
      expect((await traces(seeded)).runs).toBe(4);
    } finally {
      await holder.finish();
    }
  }, 60_000);

  it('answers 429 with Retry-After once the line outlasts its wait, and other workspaces keep being served', async () => {
    const other = await seedWebhook(`burst-other-${randomUUID()}`);
    const seeded = await seedWebhook(`burst-${randomUUID()}`);
    const holder = await holdRows(seeded.workspaceId);
    try {
      await holder.client.query(ADMISSION_ROW, [seeded.workspaceId]);
      // Each three at a time give up on the row at the lock timeout, so the line only
      // reaches its 20 second wait with this many in it.
      const line = Array.from({ length: 16 }, () => deliver(seeded));
      await holder.waitForWaiters(3);
      expect((await deliver(other)).status).toBe(202);
      const answers = await Promise.all(line);
      const refused = answers.filter(({ status }) => status === 429);
      const timedOut = answers.filter(({ status }) => status === 503);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.length + timedOut.length).toBe(answers.length);
      for (const answer of refused) {
        expect(answer.body).toMatchObject({ code: 'webhook.rate_limited' });
        expect(answer.headers['retry-after']).toBe('5');
      }
      for (const answer of timedOut)
        expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
      expect((await traces(seeded)).runs).toBe(0);
      expect(
        (await rejectedRows(seeded)).filter(
          ({ outcome }) => outcome === 'rate_limited',
        ),
      ).toHaveLength(refused.length);
      await holder.finish();
      // Nothing stays stuck once the row is free.
      expect((await deliver(seeded)).status).toBe(202);
    } finally {
      await holder.finish();
    }
  }, 90_000);

  it.each([
    ['provision', 'naming a mode', { authentication: { mode: 'secret_url' } }],
    ['provision', 'naming nothing we know', { anything: true }],
    [
      'rotate-endpoint',
      'naming a mode',
      { authentication: { mode: 'secret_url' } },
    ],
    ['rotate-endpoint', 'naming nothing we know', { anything: true }],
  ] as const)(
    '%s refuses a body %s and changes nothing, then works with none or {}',
    async (command, _name, payload) => {
      const seeded = await seedWebhook(`body-${randomUUID()}`);
      const session = await issueBrowserSession(
        identityRuntime.dependencies.sessions,
        seeded.actorId,
      );
      const url = `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/${command}`;
      const headers = (key: string) => ({
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'idempotency-key': key,
      });
      const endpoint = await endpointOf(seeded);
      const receipts = async () =>
        (
          await inWorkspace<{ count: number }>(
            seeded.workspaceId,
            `select count(*)::int count from app.idempotency_records
              where workspace_id=$1 and operation like 'webhook.trigger.%'`,
            [seeded.workspaceId],
          )
        ).rows[0]?.count;
      const receiptsBefore = await receipts();

      const refused = await application.inject({
        method: 'POST',
        url,
        headers: headers(randomUUID()),
        payload,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'request.invalid' });
      expect(await endpointOf(seeded)).toEqual(endpoint);
      expect(await receipts()).toBe(receiptsBefore);

      if (command === 'rotate-endpoint') {
        const withEmptyObject = await application.inject({
          method: 'POST',
          url,
          headers: headers(randomUUID()),
          payload: {},
        });
        expect(withEmptyObject.statusCode, withEmptyObject.body).toBe(200);
        const firstHash = (await endpointOf(seeded)).endpoint_key_hash;
        expect(firstHash).not.toBe(endpoint.endpoint_key_hash);
        const withNoBody = await application.inject({
          method: 'POST',
          url,
          headers: headers(randomUUID()),
        });
        expect(withNoBody.statusCode, withNoBody.body).toBe(200);
        expect((await endpointOf(seeded)).endpoint_key_hash).not.toBe(
          firstHash,
        );
        return;
      }
      // Provisioned already, so the same request is its receipt, with or without a body.
      for (const request of [{ payload: {} }, {}]) {
        const answered = await application.inject({
          method: 'POST',
          url,
          headers: headers(`direct-webhook-provision-${seeded.provisionLabel}`),
          ...request,
        });
        expect(answered.statusCode, answered.body).toBe(200);
      }
      expect(await endpointOf(seeded)).toEqual(endpoint);
    },
    60_000,
  );
}

/**
 * Another connection with a transaction left open, on a role that may write anything
 * these tests change, so the test decides when it commits.
 */
async function holdRows(workspaceId: string) {
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
