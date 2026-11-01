import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../src/tenant-access/transactions.js';
import {
  captureWorkspaceVariableRevision,
  lockVariableSet,
  lockWorkspaceVariableNames,
} from '../../src/variables/head.queries.js';
import { admin, createFamily } from '../lifecycle/calls/fixtures.js';
import {
  adminUrl,
  apiUrl,
  withApplicationName,
  withDatabase,
} from '../lifecycle/retention.support.js';
import { waitForApplicationLock } from '../support/postgres/lock-coordination.js';

const waitingApplication = `variable-head-${randomUUID()}`;
let pool: Pool;
let waitingPool: Pool;
beforeAll(() => {
  pool = new Pool({ connectionString: apiUrl, max: 2 });
  waitingPool = new Pool({
    connectionString: withApplicationName(apiUrl, waitingApplication),
    max: 1,
  });
});
afterAll(() => Promise.all([pool.end(), waitingPool.end()]));

async function setHead(workspaceId: string, revision: number, values: object) {
  await admin.query(
    'insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,$2,$3::jsonb)',
    [workspaceId, revision, JSON.stringify(values)],
  );
  await admin.query(
    `insert into app.workspace_variables(workspace_id,revision) values($1,$2)
     on conflict (workspace_id) do update set revision=excluded.revision`,
    [workspaceId, revision],
  );
}

const capture = (workspaceId: string) =>
  withWorkspaceTransaction(pool, workspaceId, captureWorkspaceVariableRevision);
const names = (workspaceId: string) =>
  withTenantScopedClient(pool, { workspaceId }, (client) =>
    lockWorkspaceVariableNames(client, workspaceId),
  );

it('treats a workspace with no head as fixed revision zero: no reference and no names', async () => {
  const { workspaceId } = await createFamily();
  expect(await capture(workspaceId)).toBeNull();
  expect(await names(workspaceId)).toEqual([]);
});

it('reads the names and revision of the current head', async () => {
  const { workspaceId } = await createFamily();
  await setHead(workspaceId, 1, { OLD: 1 });
  await setHead(workspaceId, 2, { CURRENCY: 'EUR', RATE: 10 });
  expect(await capture(workspaceId)).toBe(2);
  expect([...(await names(workspaceId))].sort()).toEqual(['CURRENCY', 'RATE']);
});

it('refuses a run reference to a set that only another workspace holds', async () => {
  const mine = await createFamily();
  const theirs = await createFamily();
  await setHead(theirs.workspaceId, 5, { THEIRS: 'private' });
  await expect(
    admin.query(
      'update app.workflow_runs set variable_set_revision=5 where id=$1',
      [mine.parentRunId],
    ),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'workflow_runs_variable_set_fk',
  });
});

it('refuses a head pointing at a set that only another workspace holds', async () => {
  const mine = await createFamily();
  const theirs = await createFamily();
  await setHead(theirs.workspaceId, 5, { THEIRS: 'private' });
  await expect(
    admin.query(
      'insert into app.workspace_variables(workspace_id,revision) values($1,5)',
      [mine.workspaceId],
    ),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'workspace_variables_set_fk',
  });
});

it('keeps stored history from being rewritten or deleted by the application role', async () => {
  const { workspaceId } = await createFamily();
  await setHead(workspaceId, 1, { RATE: 1 });
  await expect(
    withWorkspaceTransaction(pool, workspaceId, (transaction) =>
      transaction.db.execute(
        sql`delete from app.workspace_variable_set_revisions where revision=1`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: '42501' } });
  expect(
    (
      await admin.query(
        'select values_json from app.workspace_variable_set_revisions where workspace_id=$1',
        [workspaceId],
      )
    ).rows,
  ).toEqual([{ values_json: { RATE: 1 } }]);
});

it('never lets a name escape another workspace through the head queries', async () => {
  const mine = await createFamily();
  const theirs = await createFamily();
  await setHead(theirs.workspaceId, 1, { THEIRS: 'private' });
  expect(await names(mine.workspaceId)).toEqual([]);
  await expect(
    withTenantScopedClient(pool, { workspaceId: mine.workspaceId }, (client) =>
      lockWorkspaceVariableNames(client, theirs.workspaceId),
    ),
  ).resolves.toEqual([]);
});

describe('locking the set', () => {
  const lockIn = (from: Pool, workspaceId: string, lock: 'share' | 'update') =>
    withTenantScopedClient(from, { workspaceId }, (client) =>
      lockVariableSet(client, workspaceId, lock),
    );

  it.each(['share', 'update'] as const)(
    'gives null under a %s lock when the workspace has no head',
    async (lock) => {
      const { workspaceId } = await createFamily();
      expect(await lockIn(pool, workspaceId, lock)).toBeNull();
    },
  );

  it.each(['share', 'update'] as const)(
    'gives the current revision with its values and descriptions under a %s lock',
    async (lock) => {
      const { workspaceId } = await createFamily();
      await setHead(workspaceId, 1, { OLD: 1 });
      await admin.query(
        `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json,descriptions_json)
         values($1,2,'{"RATE":10}','{"RATE":"Invoice rate"}')`,
        [workspaceId],
      );
      await admin.query(
        'update app.workspace_variables set revision=2 where workspace_id=$1',
        [workspaceId],
      );
      expect(await lockIn(pool, workspaceId, lock)).toEqual({
        revision: 2,
        values: { RATE: 10 },
        descriptions: { RATE: 'Invoice rate' },
      });
    },
  );

  it.each(['share', 'update'] as const)(
    'fails under a %s lock when the head names a set that is gone, rather than reading empty',
    async (lock) => {
      const { workspaceId } = await createFamily();
      await setHead(workspaceId, 1, { RATE: 1 });
      // The foreign key forbids this state, so only a restore or a damaged
      // database reaches it: replica mode is the one way to build it here.
      await admin.query('set session_replication_role=replica');
      try {
        await admin.query(
          'update app.workspace_variables set revision=99 where workspace_id=$1',
          [workspaceId],
        );
      } finally {
        await admin.query('set session_replication_role=default');
      }
      await expect(lockIn(pool, workspaceId, lock)).rejects.toThrow(
        'Workspace variable revision is missing',
      );
    },
  );

  // A concurrent replace is what these locks are for: whoever waits must read
  // the set the head names after the wait, never the one from before it.
  it.each([
    ['share', 'commit', 2, { RATE: 'new' }],
    ['share', 'rollback', 1, { RATE: 'old' }],
    ['update', 'commit', 2, { RATE: 'new' }],
    ['update', 'rollback', 1, { RATE: 'old' }],
  ] as const)(
    'under a %s lock waits for an open edit, and after its %s reads revision %i',
    async (lock, finish, revision, values) => {
      const { workspaceId } = await createFamily();
      await setHead(workspaceId, 1, { RATE: 'old' });
      const editor = new Client({ connectionString: withDatabase(adminUrl) });
      await editor.connect();
      try {
        await editor.query('begin');
        await editor.query(
          `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
           values($1,2,'{"RATE":"new"}')`,
          [workspaceId],
        );
        await editor.query(
          'update app.workspace_variables set revision=2 where workspace_id=$1',
          [workspaceId],
        );
        const locked = lockIn(waitingPool, workspaceId, lock);
        await waitForApplicationLock(admin, waitingApplication);
        await editor.query(finish);
        expect(await locked).toEqual({ revision, values, descriptions: {} });
      } finally {
        await editor.end();
      }
    },
  );

  it('lets shared holders overlap, while an update lock waits for them', async () => {
    const { workspaceId } = await createFamily();
    await setHead(workspaceId, 1, { RATE: 'old' });
    const { update } = await withTenantScopedClient(
      pool,
      { workspaceId },
      async (client) => {
        await lockVariableSet(client, workspaceId, 'share');
        expect(await lockIn(waitingPool, workspaceId, 'share')).toMatchObject({
          revision: 1,
        });
        const waiting = lockIn(waitingPool, workspaceId, 'update');
        await waitForApplicationLock(admin, waitingApplication);
        return { update: waiting };
      },
    );
    expect(await update).toMatchObject({ revision: 1 });
  });

  it.each(['share', 'update'] as const)(
    'holds an edit back until the %s lock is let go',
    async (lock) => {
      const { workspaceId } = await createFamily();
      await setHead(workspaceId, 1, { RATE: 'old' });
      const application = `variable-editor-${randomUUID()}`;
      const editor = new Client({
        connectionString: withApplicationName(
          withDatabase(adminUrl),
          application,
        ),
      });
      await editor.connect();
      try {
        const { edit } = await withTenantScopedClient(
          pool,
          { workspaceId },
          async (client) => {
            await lockVariableSet(client, workspaceId, lock);
            await admin.query(
              `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
               values($1,2,'{"RATE":"new"}')`,
              [workspaceId],
            );
            const held = editor.query(
              'update app.workspace_variables set revision=2 where workspace_id=$1',
              [workspaceId],
            );
            await waitForApplicationLock(admin, application);
            return { edit: held };
          },
        );
        await edit;
        expect(await capture(workspaceId)).toBe(2);
      } finally {
        await editor.end();
      }
    },
  );
});
