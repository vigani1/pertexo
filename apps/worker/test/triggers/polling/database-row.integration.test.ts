import { randomUUID } from 'node:crypto';
import { createPostgresDestination } from '@pertexo/database/testing';
import {
  DATABASE_POLL_TRIGGER,
  POLL_MAX_ITEMS,
  TRIGGER_INTERVAL_MINUTES,
} from '@pertexo/workflow-model';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { composeUrls } from '../../support/recovery/environment.js';
import { required } from '../../support/recovery/facts.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';

const schema = 'Odd Schema';
const keyColumn = 'Row "ID"';
const orderingColumn = 'Last changed';
const pollTimeout = { timeout: 10_000 };
const columns =
  '"Row ""ID""" text primary key, "Last changed" int not null, payload text, duplicate text not null, pertexo_poll_key_0 bigint generated always as (9007199254740993 + "Last changed") stored';

type PostgresCredential = Awaited<
  ReturnType<typeof createPostgresDestination>
>['credential'];

let stack: Stack | undefined;
let destination:
  Awaited<ReturnType<typeof createPostgresDestination>> | undefined;
let client: pg.Client | undefined;
let workspaceId: string;
let connectionId: string;

beforeAll(async () => {
  destination = await createPostgresDestination(composeUrls.admin);
  client = new pg.Client(destination.credential);
  await client.connect();
  await client.query('create schema "Odd Schema"');
  stack = await startStack('postgres-poll', {
    workerEnvironment: { TRIGGER_SCHEDULE_POLL_MILLIS: '50' },
    environment: { AUTH_SIGN_UP_MODE: 'open' },
  });
  workspaceId = await stack.api.createWorkspace('postgres-poll');
  connectionId = await connection(destination.credential);
});

afterAll(async () => {
  try {
    await stack?.close();
  } finally {
    await client?.end();
    await destination?.close();
  }
});

it.each([
  { mode: 'new_or_updated', runsAfterUpdate: 3 },
  { mode: 'new', runsAfterUpdate: 2 },
] as const)(
  'baselines and admits unseen rows in $mode mode',
  async ({ mode, runsAfterUpdate }) => {
    const { table, relation, sql } = await createTable();
    await sql.query(
      `insert into ${relation} values ('old', 1, 'baseline', 'same')`,
    );
    const poll = await publish(table, { mode });
    await expect
      .poll(poll.state, pollTimeout)
      .toMatchObject({ count: 1, error: null, due: false });
    expect(await poll.runs()).toEqual([]);

    await sql.query(
      `insert into ${relation} values ('third', 3, 'third', 'same'), ('second', 2, 'second', 'same')`,
    );
    await poll.makeDue();
    await expect
      .poll(
        async () =>
          (await poll.runs()).map(({ item, status }) => ({ item, status })),
        pollTimeout,
      )
      .toEqual([
        { item: row('second', 2, 'second'), status: 'succeeded' },
        { item: row('third', 3, 'third'), status: 'succeeded' },
      ]);
    expect((await poll.runs())[0]?.input).toMatchObject({
      kind: 'inline',
      value: { row: row('second', 2, 'second') },
    });

    await sql.query(
      `update ${relation} set "Last changed" = 4, payload = 'updated' where "Row ""ID""" = 'second'`,
    );
    await poll.makeDue();
    await expect
      .poll(poll.state, pollTimeout)
      .toMatchObject({ due: false, count: runsAfterUpdate + 1 });
    const runs = await poll.runs();
    expect(runs).toHaveLength(runsAfterUpdate);
    if (mode === 'new_or_updated')
      expect(runs[2]?.item).toEqual(row('second', 4, 'updated'));

    await poll.makeDue();
    await expect
      .poll(poll.state, pollTimeout)
      .toMatchObject({ due: false, count: runsAfterUpdate + 1 });
    expect(await poll.runs()).toHaveLength(runsAfterUpdate);
  },
);

it('baselines only the newest capped rows and refuses oversized results', async () => {
  const { table, relation, sql } = await createTable();
  await sql.query(
    `insert into ${relation} select 'row-' || n, n, 'small', 'same' from generate_series(1, $1::int) as n`,
    [POLL_MAX_ITEMS + 1],
  );
  const poll = await publish(table);
  await expect
    .poll(poll.state, pollTimeout)
    .toMatchObject({ count: POLL_MAX_ITEMS, error: null, due: false });
  expect(await poll.runs()).toEqual([]);
  await sql.query(
    `update ${relation} set "Last changed" = $1 where "Last changed" = 1`,
    [POLL_MAX_ITEMS + 2],
  );
  await poll.makeDue();
  await expect
    .poll(async () => (await poll.runs()).map(({ item }) => item), pollTimeout)
    .toEqual([row('row-1', POLL_MAX_ITEMS + 2, 'small')]);
  await expect.poll(poll.state, pollTimeout).toMatchObject({
    due: false,
    count: POLL_MAX_ITEMS + 1,
  });
  await sql.query(
    `update ${relation} set payload = repeat('x', $1) where "Last changed" = $2`,
    [150_000, POLL_MAX_ITEMS + 2],
  );
  await poll.makeDue();
  await expect.poll(poll.state, pollTimeout).toMatchObject({
    error: 'database.result_limit',
    count: POLL_MAX_ITEMS + 1,
  });
});

it('fails safely when the key column is not unique', async () => {
  const { table, relation, sql } = await createTable();
  await sql.query(
    `insert into ${relation} values ('one', 1, 'first', 'same'), ('two', 2, 'second', 'same')`,
  );
  const poll = await publish(table, { keyColumn: 'duplicate' });
  await expect.poll(poll.state, pollTimeout).toMatchObject({
    count: null,
    error: 'database.key_not_unique',
    paused: false,
  });
  expect(await poll.runs()).toEqual([]);
});

it('refuses a database address outside the worker allowlist', async () => {
  const { table } = await createTable();
  const blocked = await connection({
    ...required(destination, 'destination').credential,
    host: '127.0.0.2',
  });
  const poll = await publish(table, {}, blocked);
  await expect.poll(poll.state, pollTimeout).toMatchObject({
    count: null,
    error: 'database.address_blocked',
    paused: false,
  });
});

it('pauses on the first rejected login and records safe evidence', async () => {
  const { table } = await createTable();
  const password = randomUUID();
  const invalid = await connection({
    ...required(destination, 'destination').credential,
    password,
  });
  const poll = await publish(table, {}, invalid);
  await expect.poll(poll.state, pollTimeout).toMatchObject({
    count: null,
    error: 'database.authentication_failed',
    paused: true,
    pauseEvidence: 'database.authentication_failed',
    failures: 1,
  });
  expect(await poll.runs()).toEqual([]);
  expect(
    JSON.stringify(required(stack, 'test stack').worker.logs),
  ).not.toContain(password);
});

it('reads through a policy that requires a read-only transaction', async () => {
  const { table, relation, sql } = await createTable();
  await sql.query(
    `insert into ${relation} values ('read', 1, 'baseline', 'same')`,
  );
  await sql.query(`alter table ${relation} enable row level security`);
  await sql.query(`alter table ${relation} force row level security`);
  await sql.query(
    `create policy read_only on ${relation} for select using (current_setting('transaction_read_only') = 'on')`,
  );
  const poll = await publish(table);
  await expect
    .poll(poll.state, pollTimeout)
    .toMatchObject({ count: 1, error: null, due: false });
  expect(await poll.runs()).toEqual([]);
});

function row(id: string, order: number, payload: string) {
  return {
    [keyColumn]: id,
    [orderingColumn]: order,
    payload,
    duplicate: 'same',
    pertexo_poll_key_0: String(9007199254740993n + BigInt(order)),
  };
}

async function createTable() {
  const sql = required(client, 'destination connection');
  const table = `Items "${randomUUID().slice(0, 8)}"`;
  const relation = `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`;
  await sql.query(`create table ${relation} (${columns})`);
  return { table, relation, sql };
}

async function connection(credential: PostgresCredential) {
  const response = await required(stack, 'test stack').api.call(
    'POST',
    `/v1/workspaces/${workspaceId}/connections`,
    { providerKey: 'postgres', name: `PostgreSQL ${randomUUID()}`, credential },
    { 'idempotency-key': randomUUID() },
  );
  expect(response.status).toBe(201);
  return (response.json as { id: string }).id;
}

async function publish(
  table: string,
  override: Readonly<Record<string, unknown>> = {},
  selectedConnection = connectionId,
) {
  const { api, sql } = required(stack, 'test stack');
  const workflow = await api.publish(workspaceId, 'Database Row polling', {
    settings: {},
    nodes: [
      {
        id: 'poll',
        definition: DATABASE_POLL_TRIGGER,
        position: { x: 0, y: 0 },
        configVersion: 1,
        inputMappings: {},
        connectionRefs: { postgres: selectedConnection },
        config: {
          schema,
          table,
          keyColumn,
          orderingColumn,
          intervalMinutes: TRIGGER_INTERVAL_MINUTES.minimum,
          mode: 'new',
          ...override,
        },
      },
      {
        id: 'consume',
        definition: { key: 'core.set', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        connectionRefs: {},
        inputMappings: {
          row: { kind: 'node_output', nodeId: 'poll', path: '$.item' },
        },
      },
    ],
    edges: [
      {
        id: 'poll-output',
        source: { nodeId: 'poll', port: 'out' },
        target: { nodeId: 'consume', port: 'in' },
      },
    ],
  });

  return {
    state: async () =>
      (
        await sql(
          `select cardinality(poll.seen_keys) count, trigger.last_error_code error,
         poll.next_poll_at <= statement_timestamp() due,
         workflow.trigger_pause_state = 'paused' paused,
         workflow.trigger_pause_poll_error_code "pauseEvidence",
         workflow.trigger_pause_failures failures
       from app.trigger_polls poll
       join app.workflow_triggers trigger on trigger.id = poll.trigger_id
       join app.workflows workflow on workflow.id = trigger.workflow_id
       where workflow.id = $1`,
          [workflow],
        )
      )[0],
    makeDue: () =>
      sql(
        `update app.trigger_polls set next_poll_at = statement_timestamp()
       from app.workflow_triggers trigger
       where trigger.id = trigger_polls.trigger_id and trigger.workflow_id = $1`,
        [workflow],
      ),
    runs: () =>
      sql<{ item: unknown; input: unknown; status: string }>(
        `select run.input_ref->'value'->'item' item, node.input_ref input, run.status
       from app.workflow_runs run
       left join app.node_runs node on node.workflow_run_id = run.id and node.node_id = 'consume'
       where run.workflow_id = $1 and run.trigger_type = 'polling'
       order by run.admission_ticket`,
        [workflow],
      ),
  };
}
