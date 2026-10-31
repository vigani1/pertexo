import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../src/tenant-access/transactions.js';
import {
  captureWorkspaceVariableRevision,
  lockWorkspaceVariableNames,
} from '../../src/variables/head.queries.js';
import { admin, createFamily } from '../lifecycle/calls/fixtures.js';
import { apiUrl } from '../lifecycle/retention.support.js';

let pool: Pool;
beforeAll(() => {
  pool = new Pool({ connectionString: apiUrl, max: 2 });
});
afterAll(() => pool.end());

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
