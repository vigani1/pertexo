import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  withActorScopedClient,
  withMultiWorkspaceTransaction,
  withPlatformTransaction,
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../src/tenant-access/transactions.js';
import {
  POOL_ROLES,
  admin,
  databaseName,
  productionPool,
  setUpDatabase,
  tearDownDatabase,
} from './tenant-context-pools/fixture.js';

// A pure step runs about ten transactions and was measured at 86 statements
// against a budget of 90 (docs/feature-plans/step-transaction-cost.md). One more
// ceremony statement per transaction would break that budget, so the ceremony
// itself is held here, as PostgreSQL counts it.
// begin, the one context statement, commit; a platform transaction without a
// timeout has no context to set.
const SCOPED_CEREMONY = 3;
const PLATFORM_CEREMONY = 2;
const RUNS = 20;

beforeAll(async () => {
  await setUpDatabase();
  await admin.query('create extension if not exists pg_stat_statements');
}, 60_000);
afterAll(tearDownDatabase);

let pool: Pool;

beforeAll(() => {
  pool = productionPool('worker', POOL_ROLES[1].url, 2);
});

/** Statements the application role ran in this database since the last reset. */
async function applicationStatements(): Promise<
  readonly Readonly<{ query: string; calls: number }>[]
> {
  const result = await admin.query<{ query: string; calls: string }>(
    `select query, calls from pg_stat_statements s
      join pg_database d on d.oid = s.dbid
      where d.datname = $1 and s.userid = 'pertexo_app'::regrole`,
    [databaseName],
  );
  return result.rows.map((row) => ({
    query: row.query,
    calls: Number(row.calls),
  }));
}

async function measure(transactions: () => Promise<unknown>) {
  // Connections are opened first so pooled start-up is not counted.
  await Promise.all([
    withPlatformTransaction(pool, () => Promise.resolve()),
    withPlatformTransaction(pool, () => Promise.resolve()),
  ]);
  await admin.query(
    `select pg_stat_statements_reset(0, (select oid from pg_database where datname=$1), 0)`,
    [databaseName],
  );
  await transactions();
  return applicationStatements();
}

const total = (rows: readonly { calls: number }[]) =>
  rows.reduce((sum, row) => sum + row.calls, 0);

it.each([
  [
    'workspace',
    SCOPED_CEREMONY,
    () =>
      withTenantScopedClient(
        pool,
        { workspaceId: randomUUID(), actorId: randomUUID() },
        (client) => client.query('select 1 as operation'),
        { statementTimeoutMillis: 5_000 },
      ),
  ],
  [
    'workspace read',
    SCOPED_CEREMONY,
    () =>
      withTenantScopedReadClient(
        pool,
        { workspaceId: randomUUID() },
        (client) => client.query('select 1 as operation'),
      ),
  ],
  [
    'actor',
    SCOPED_CEREMONY,
    () =>
      withActorScopedClient(pool, randomUUID(), (client) =>
        client.query('select 1 as operation'),
      ),
  ],
  [
    'platform',
    PLATFORM_CEREMONY,
    () =>
      withPlatformTransaction(pool, (client) =>
        client.query('select 1 as operation'),
      ),
  ],
])(
  'a %s transaction adds at most the fixed ceremony, and never reads pg_settings',
  async (_kind, ceremony, transaction) => {
    const rows = await measure(async () => {
      for (let run = 0; run < RUNS; run += 1) await transaction();
    });
    expect(rows.filter((row) => /pg_settings/iu.test(row.query))).toEqual([]);
    const operations = total(
      rows.filter((row) => row.query.includes('as operation')),
    );
    expect(operations).toBe(RUNS);
    expect(total(rows) - operations).toBeLessThanOrEqual(RUNS * ceremony);
  },
);

it('a multi-workspace transaction costs one statement to enter and one to leave each scope', async () => {
  const rows = await measure(async () => {
    for (let run = 0; run < RUNS; run += 1)
      await withMultiWorkspaceTransaction(pool, async (inWorkspace) => {
        await inWorkspace({ workspaceId: randomUUID() }, (client) =>
          client.query('select 1 as operation'),
        );
        await inWorkspace({ workspaceId: randomUUID() }, (client) =>
          client.query('select 1 as operation'),
        );
      });
  });
  expect(rows.filter((row) => /pg_settings/iu.test(row.query))).toEqual([]);
  const operations = total(
    rows.filter((row) => row.query.includes('as operation')),
  );
  expect(operations).toBe(RUNS * 2);
  // begin, commit, and per scope: the nesting check, enter and leave.
  expect(total(rows) - operations).toBeLessThanOrEqual(RUNS * (2 + 2 * 3));
});
