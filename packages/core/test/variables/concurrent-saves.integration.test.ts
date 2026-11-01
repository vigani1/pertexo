import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceVariablesConflictError } from '../../src/variables/contract.js';
import { createWorkspaceVariablesStore } from '../../src/variables/store.js';

import { admin } from '../lifecycle/calls/fixtures.js';
import { apiUrl, withApplicationName } from '../lifecycle/retention.support.js';
import { waitForApplicationLock } from '../support/postgres/lock-coordination.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  pool,
  scope,
  store,
} from './configuration/fixture.js';

const blockedApplication = `variable-replace-${randomUUID()}`;
let blockedStore: ReturnType<typeof createWorkspaceVariablesStore>;

beforeAll(() => {
  beforeAllFixture1();
  blockedStore = createWorkspaceVariablesStore(
    parseDatabaseConfig({
      connectionString: withApplicationName(apiUrl, blockedApplication),
      max: 1,
    }),
  );
});
afterAll(async () => {
  await blockedStore.close();
  await afterAllFixture2();
});

describe('a save that meets another open save', () => {
  /** Runs a save while another transaction holds the given statements, then ends it. */
  async function saveAgainst(
    workspaceId: string,
    statements: readonly string[],
    finish: 'commit' | 'rollback',
    expectedRevision: number,
  ) {
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      await writer.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      for (const statement of statements)
        await writer.query(statement, [workspaceId]);
      const pending = blockedStore.replace({
        ...scope(workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision,
        values: { RATE: 'mine' },
      });
      const settled = pending.then(
        (value) => ({ status: 'accepted', value }) as const,
        (reason: unknown) => ({ status: 'refused', reason }) as const,
      );
      await waitForApplicationLock(admin, blockedApplication);
      await writer.query(finish);
      return await settled;
    } finally {
      await writer.query('rollback');
      writer.release();
    }
  }

  const firstSave = [
    `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{"RATE":"theirs"}')`,
    'insert into app.workspace_variables(workspace_id,revision) values($1,1)',
  ];
  const nextSave = [
    `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,2,'{"RATE":"theirs"}')`,
    'update app.workspace_variables set revision=2 where workspace_id=$1',
  ];

  it('loses to a first save that commits, with the typed conflict and their values kept', async () => {
    const f = await fixture();
    const result = await saveAgainst(f.workspaceId, firstSave, 'commit', 0);
    expect(result.status === 'refused' && result.reason).toBeInstanceOf(
      WorkspaceVariablesConflictError,
    );
    expect(await store.read(scope(f.workspaceId))).toMatchObject({
      revision: 1,
      values: { RATE: 'theirs' },
    });
  });

  it('becomes the first save when the other one rolls back', async () => {
    const f = await fixture();
    expect(
      await saveAgainst(f.workspaceId, firstSave, 'rollback', 0),
    ).toMatchObject({ status: 'accepted', value: { revision: 1 } });
    expect(await store.read(scope(f.workspaceId))).toMatchObject({
      revision: 1,
      values: { RATE: 'mine' },
    });
  });

  it.each([
    ['commit', 'refused', 2, 'theirs'],
    ['rollback', 'accepted', 2, 'mine'],
  ] as const)(
    'decides from the head after waiting: another edit that ends in %s leaves this save %s',
    async (finish, status, revision, value) => {
      const f = await fixture();
      await store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        values: { RATE: 'before' },
      });
      const result = await saveAgainst(f.workspaceId, nextSave, finish, 1);
      expect(result.status).toBe(status);
      expect(await store.read(scope(f.workspaceId))).toMatchObject({
        revision,
        values: { RATE: value },
      });
    },
  );
});
