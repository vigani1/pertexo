import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findCoreQueries,
  findStoreProblems,
  isPending,
  validatePendingAreas,
} from './validate-core-queries.mjs';

const OPERATION = 'packages/core/src/variables/replace.ts';
const find = (text, file = OPERATION) => findCoreQueries(file, text);

test('refuses queries an operation runs on a client, transaction or pool', () => {
  for (const text of [
    'await drizzle(client).select({ id: t.id }).from(t);',
    'await db.select().from(t);',
    'await tx.insert(t).values(row);',
    'await transaction.db.update(t).set({ a: 1 }).where(c);',
    'await db.delete(t).where(c);',
    'await db.execute(statement);',
    "await client.query('select 1');",
    'await pool.query<{ now: Date }>(text);',
    'await this.db.selectDistinct().from(t);',
  ])
    assert.equal(find(text).length, 1, text);
});

test('refuses the shapes a handle takes without a handle name', () => {
  for (const text of [
    'await drizzle(client).execute(STATEMENT).catch(rethrowQueryFailure);',
    'await drizzle(client).insert(t).select(origin).catch(x);',
    'await writer.insert(t).select(origin);',
    'withTenantScopedClient(pool, s, (c) => c.query(text));',
    'withPlatformTransaction(pool, async function (c) { await c.execute(x); });',
    'async function f(maintenance: Pool) { await maintenance.query(text); }',
    'async function f(c: PoolClient) { await c.execute(statement); }',
    'async function f(t: WorkspaceTransaction) { await t.db.execute(s); }',
    "import { sql as q } from 'drizzle-orm'; const at = q`now()`;",
    "import { sql as q } from 'drizzle-orm'; const raw = q.raw('select 1');",
  ])
    assert.equal(find(text).length, 1, text);
});

test('refuses a builder chain whatever its receiver is called', () => {
  assert.equal(find('await writer.update(t).set({ a: 1 });').length, 1);
  assert.equal(find('await rows.delete(t).where(c);').length, 1);
});

test('refuses sql fragments, clock reads and increments included', () => {
  for (const text of [
    'const at = sql`clock_timestamp()`;',
    'const next = { revision: sql`${t.revision}+1` };',
    'const now = sql`now()`;',
    "const name = sql.identifier('t');",
    "const raw = sql.raw('select 1');",
    'const list = sql.join(parts, sep);',
  ])
    assert.equal(find(text).length, 1, text);
});

test('leaves Map, Set and other non-database calls alone', () => {
  for (const text of [
    'pending.delete(key);',
    'const seen = new Set(); seen.delete(x);',
    'store.delete(id);',
    'cache.update(key, value);',
    'headers.select(name);',
    "document.querySelector('a');",
    'params.query(text);',
    'const x = sqlish`a`;',
    "const label = 'select * from t';",
    'list.insert(0, item);',
    'items.map((c) => c.delete);',
    'withRetry(() => cache.delete(key));',
    "import { sql as q } from 'other'; const at = q`a`;",
    'async function f(c: Counter) { c.update(1); }',
  ])
    assert.deepEqual(find(text), [], text);
});

test('lets repositories and stores hold queries, and ignores files outside core', () => {
  const query = 'await db.select().from(t); const at = sql`now()`;';
  assert.deepEqual(
    find(query, 'packages/core/src/variables/set.repository.ts'),
    [],
  );
  assert.deepEqual(
    find(query, 'packages/core/src/variables/workspace-variables.store.ts'),
    [],
  );
  assert.deepEqual(find(query, 'packages/database/src/outbox/events.ts'), []);
});

test('pending areas are skipped, and the pending list may only shrink', () => {
  assert.equal(isPending('packages/core/src/runs/access.ts', ['runs']), true);
  assert.equal(isPending(OPERATION, ['runs']), false);
  assert.equal(isPending('packages/core/src/testing.ts', ['runs']), false);
  assert.deepEqual(validatePendingAreas(['runs']), []);
  assert.equal(validatePendingAreas(['runs', 'artifacts']).length, 1);
});

test('a store is a facade: it exports a factory and something composes it', () => {
  const store = 'packages/core/src/variables/workspace-variables.store.ts';
  const entry = [
    'packages/core/src/variables/index.ts',
    "export { createWorkspaceVariablesStore } from './workspace-variables.store.js';",
  ];
  const facade = 'export function createWorkspaceVariablesStore(pool) {}';
  assert.deepEqual(findStoreProblems([entry, [store, facade]]), []);

  const composer = [
    'packages/core/src/tenant-access/identity-workspace.store.ts',
    "import { createUserStore } from './users/user.store.js';\nexport const createIdentityWorkspaceStore = () => {};",
  ];
  const composedStore = [
    'packages/core/src/tenant-access/users/user.store.ts',
    'export function createUserStore(pool) {}',
  ];
  assert.deepEqual(
    findStoreProblems([
      [
        'packages/core/src/tenant-access/index.ts',
        "export * from './identity-workspace.store.js';",
      ],
      composer,
      composedStore,
    ]),
    [],
  );

  assert.equal(
    findStoreProblems([entry, [store, 'export async function readRows() {}']])
      .length,
    1,
  );
  assert.equal(findStoreProblems([[store, facade]]).length, 1);
});
