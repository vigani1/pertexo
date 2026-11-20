import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDestination } from '@pertexo/database/testing';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import { composeUrls } from '../../support/recovery/environment.js';
import { required, waitForRunsToEnd } from '../../support/recovery/facts.js';
import { httpChain } from '../../support/recovery/graphs.js';

type PostgresCredential = Awaited<
  ReturnType<typeof createPostgresDestination>
>['credential'];

describe('Database step against a separate PostgreSQL database and login', () => {
  let stack: Stack;
  let target: Awaited<ReturnType<typeof createPostgresDestination>>;
  let closeStack = () => Promise.resolve();
  let closeTarget = () => Promise.resolve();
  let workspaceId: string;
  let writable: string;
  let readOnly: string;
  const table = { schema: 'Odd Schema', table: 'Items "2026"' };
  const relation = '"Odd Schema"."Items ""2026"""';

  beforeAll(async () => {
    target = await createPostgresDestination(composeUrls.admin);
    closeTarget = () => target.close();
    const client = new pg.Client(target.credential);
    await client.connect();
    try {
      await client.query('create schema "Odd Schema"');
      await client.query(
        `create table ${relation} ("Item ID" int primary key, "display""name" text not null)`,
      );
    } finally {
      await client.end();
    }
    stack = await startStack('postgres-step', {
      redisDatabase: 12,
      environment: { AUTH_SIGN_UP_MODE: 'open' },
    });
    closeStack = stack.close;
    workspaceId = await stack.api.createWorkspace('postgres-step');
    writable = await createConnection('Writable PostgreSQL', target.credential);
    readOnly = await createConnection('Read-only PostgreSQL', {
      ...target.credential,
      readOnly: true,
    });
  });

  afterAll(async () => {
    try {
      await closeStack();
    } finally {
      await closeTarget();
    }
  });

  async function createConnection(
    name: string,
    credential: PostgresCredential,
  ) {
    const created = await stack.api.call(
      'POST',
      `/v1/workspaces/${workspaceId}/connections`,
      {
        providerKey: 'postgres',
        name,
        credential,
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.json)).not.toContain(credential.password);
    return (created.json as { id: string }).id;
  }

  async function run(
    config: Readonly<Record<string, unknown>>,
    mapped: Readonly<Record<string, unknown>> = {},
    connectionId = writable,
    retry?: { maximumAttempts: number; delayMillis: number },
  ) {
    const graph = httpChain([
      { id: 'database', url: 'https://fixture.invalid/', method: 'GET' },
    ]);
    const workflow = await stack.api.publish(
      workspaceId,
      'Database operation',
      {
        ...graph,
        nodes: [
          graph.nodes[0],
          {
            ...graph.nodes[1],
            definition: { key: 'database.execute', version: 1 },
            config,
            ...(retry === undefined ? {} : { retry }),
            inputMappings: Object.fromEntries(
              Object.entries(mapped).map(([name, value]) => [
                name,
                { kind: 'literal', value },
              ]),
            ),
            connectionRefs: { postgres: connectionId },
          },
        ],
      },
    );
    const runId = await stack.api.startRun(workspaceId, workflow);
    const facts = (await waitForRunsToEnd(stack, [runId], 20_000))[runId];
    const [result] = await stack.sql<{
      output_ref: unknown;
      safe_error_code: string | null;
      error_summary: string | null;
    }>(
      `select node.output_ref, attempt.safe_error_code, attempt.error_summary
        from app.node_runs node join app.node_attempts attempt on attempt.id = node.current_attempt_id
        where node.workflow_run_id = $1 and node.node_id = 'database'`,
      [runId],
    );
    return {
      ...required(result, 'stored database attempt'),
      status: facts?.status,
      runId,
    };
  }

  it('tests the PostgreSQL connection without returning credentials', async () => {
    const response = await stack.api.call(
      'POST',
      `/v1/workspaces/${workspaceId}/connections/${writable}/test`,
      {
        providerKey: 'postgres',
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ outcome: { ok: true } });
    expect(JSON.stringify(response.json)).not.toContain(
      target.credential.password,
    );
  });

  it('binds mapped parameters as data, including strings that look like SQL', async () => {
    const dangerous = "'; drop table orders; --";
    const result = await run(
      {
        operation: 'query',
        sql: 'select $1::text as value, $2::integer as quantity',
      },
      {
        parameters: [dangerous, 7],
      },
      readOnly,
    );
    expect(result.status).toBe('succeeded');
    expect(result.output_ref).toEqual({
      kind: 'inline',
      value: {
        items: [{ value: dangerous, quantity: 7 }],
        rowCount: 1,
      },
    });
  });

  it('inserts, updates and upserts rows with quoted identifiers', async () => {
    const row = (name: string) => ({ 'Item ID': 1, 'display"name': name });
    const inserted = await run(
      { ...table, operation: 'insert' },
      { rows: [row('inserted')] },
    );
    const updated = await run(
      { ...table, operation: 'update', key: 'Item ID' },
      {
        rows: [row('updated')],
      },
    );
    const upserted = await run(
      { ...table, operation: 'upsert', keys: 'Item ID' },
      { rows: [row('upserted')] },
    );
    for (const [result, name] of [
      [inserted, 'inserted'],
      [updated, 'updated'],
      [upserted, 'upserted'],
    ] as const)
      expect(result.output_ref).toEqual({
        kind: 'inline',
        value: { items: [row(name)], rowCount: 1 },
      });
    const stored = await run({
      operation: 'query',
      sql: `select * from ${relation} where "Item ID" = 1`,
    });
    expect(stored.output_ref).toEqual(upserted.output_ref);
  });

  it.each([
    [
      'read_only',
      `insert into ${relation} values (20, 'blocked')`,
      'readonly',
      {},
    ],
    ['syntax_error', 'select )', 'writable', {}],
    ['syntax_error', 'select 1; select 2', 'writable', {}],
    [
      'constraint_violation',
      `insert into ${relation} values (20, null)`,
      'writable',
      {},
    ],
    [
      'row_limit',
      'select generate_series(1, 3) as value',
      'writable',
      { maxRows: 2 },
    ],
    ['result_limit', "select repeat('x', 150000) as value", 'writable', {}],
    ['timeout', 'select pg_sleep(2)', 'writable', { timeoutMillis: 250 }],
    [
      'serialization',
      'do $$ begin raise serialization_failure; end $$',
      'writable',
      {},
    ],
    ['query_failed', 'select no_such_field', 'writable', {}],
  ] as const)('records %s for %s', async (code, sql, login, limits) => {
    const result = await run(
      { operation: 'query', sql, ...limits },
      {},
      login === 'readonly' ? readOnly : writable,
    );
    expect(result.status).toBe('failed');
    expect(result.safe_error_code).toBe(`database.${code}`);
    if (sql === 'select )')
      expect(result.error_summary).toContain('Position 8.');
  });

  it('retries serialization failures and leaves SQL errors at one attempt', async () => {
    const retry = { maximumAttempts: 2, delayMillis: 1_000 };
    const serialized = await run(
      {
        operation: 'query',
        sql: 'do $$ begin raise serialization_failure; end $$',
      },
      {},
      writable,
      retry,
    );
    const malformed = await run(
      { operation: 'query', sql: 'select )' },
      {},
      writable,
      retry,
    );
    const attempts = await stack.sql<{
      workflow_run_id: string;
      total: number;
    }>(
      `select node.workflow_run_id, count(*)::int as total from app.node_attempts attempt
        join app.node_runs node on node.id = attempt.node_run_id
        where node.workflow_run_id = any($1::uuid[]) and node.node_id = 'database'
        group by node.workflow_run_id`,
      [[serialized.runId, malformed.runId]],
    );
    expect(attempts).toEqual(
      expect.arrayContaining([
        { workflow_run_id: serialized.runId, total: 2 },
        { workflow_run_id: malformed.runId, total: 1 },
      ]),
    );
  });

  it('rejects a column absent from the database before writing', async () => {
    const result = await run(
      { ...table, operation: 'insert' },
      { rows: [{ missing: 1 }] },
    );
    expect(result.status).toBe('failed');
    expect(result.safe_error_code).toBe('database.invalid_columns');
  });

  it('writes a mapped batch atomically and sums the result rows', async () => {
    const first = { 'Item ID': 41, 'display"name': 'first' };
    const second = { 'Item ID': 42, 'display"name': 'second' };
    const result = await run(
      { ...table, operation: 'insert' },
      { rows: [first, second] },
    );
    expect(result.output_ref).toEqual({
      kind: 'inline',
      value: { items: [first, second], rowCount: 2 },
    });
    const rolledBack = await run(
      { ...table, operation: 'insert', maxRows: 1 },
      {
        rows: [
          { ...first, 'Item ID': 43 },
          { ...second, 'Item ID': 44 },
        ],
      },
    );
    expect(rolledBack.safe_error_code).toBe('database.row_limit');
    const check = await run({
      operation: 'query',
      sql: `select * from ${relation} where "Item ID" >= 43`,
    });
    expect(check.output_ref).toMatchObject({
      value: { items: [], rowCount: 0 },
    });
  });

  it('does not persist updates when RETURNING exceeds the row limit', async () => {
    await run({
      operation: 'query',
      sql: `insert into ${relation} values (30, 'before'), (31, 'before')`,
    });
    const result = await run({
      operation: 'query',
      maxRows: 1,
      sql: `update ${relation} set "display""name" = 'after' where "Item ID" in (30, 31) returning *`,
    });
    expect(result.safe_error_code).toBe('database.row_limit');
    const read = await run({
      operation: 'query',
      sql: `select distinct "display""name" as value from ${relation} where "Item ID" in (30, 31)`,
    });
    expect(read.output_ref).toMatchObject({
      value: { items: [{ value: 'before' }] },
    });
  });

  it('records a safe failed login and keeps the password out of the run and logs', async () => {
    const password = randomUUID();
    const connection = await createConnection('Invalid PostgreSQL login', {
      ...target.credential,
      password,
    });
    const result = await run(
      { operation: 'query', sql: 'select 1' },
      {},
      connection,
    );
    expect(result.safe_error_code).toBe('database.authentication_failed');
    const response = await stack.api.call(
      'GET',
      `/v1/workspaces/${workspaceId}/runs/${result.runId}`,
    );
    expect(response.status).toBe(200);
    for (const evidence of [
      result,
      response.json,
      stack.worker.logs,
      stack.apiProcess.logs,
    ])
      expect(JSON.stringify(evidence)).not.toContain(password);
  });

  it('distinguishes a refused socket from bad credentials', async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Test port unavailable');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    const connection = await createConnection('Closed PostgreSQL socket', {
      ...target.credential,
      port: address.port,
    });
    const result = await run(
      { operation: 'query', sql: 'select 1' },
      {},
      connection,
    );
    expect(result.safe_error_code).toBe('database.connection_refused');
  });
});
