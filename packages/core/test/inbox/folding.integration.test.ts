import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  asAdmin,
  apiUrl,
  fail,
  fold,
  pending,
  seed,
  threads,
} from './threads/fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

it('folds exact cross-workspace history after the SQL rule is retired', async () => {
  const first = await seed();
  const second = await seed();
  const instant = new Date().toISOString().slice(0, 19);
  const latest = await fail(first.workspaceId, first.first, {
    kind: 'timed_out',
    occurredAt: `${instant}.000002Z`,
  });
  await fail(first.workspaceId, first.first, {
    occurredAt: `${instant}.000001Z`,
  });
  await fail(second.workspaceId, second.first);
  await asAdmin(
    'drop function if exists app.fold_workspace_inbox_events(integer,interval)',
  );

  const changes = await fold.foldPending(1_000);
  expect(new Set(changes.map(({ workspaceId }) => workspaceId))).toEqual(
    new Set([first.workspaceId, second.workspaceId]),
  );
  expect(await threads(first.workspaceId)).toEqual([
    expect.objectContaining({
      occurrence_count: '2',
      latest_kind: 'timed_out',
      latest_run_id: latest,
    }),
  ]);
  expect(await threads(second.workspaceId)).toEqual([
    expect.objectContaining({ occurrence_count: '1' }),
  ]);
  expect(await pending(first.workspaceId)).toBe(0);
  expect(await pending(second.workspaceId)).toBe(0);
  expect(await fold.foldPending(1_000)).toEqual([]);
});

it('rolls back every workspace and replays once after a thread write is refused', async () => {
  const workspaces = [await seed(), await seed()].sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId),
  );
  for (const workspace of workspaces)
    await fail(workspace.workspaceId, workspace.first);
  await fold.foldPending(1_000);
  for (const workspace of workspaces)
    await fail(workspace.workspaceId, workspace.first);
  const last = workspaces.at(-1);
  if (last === undefined) throw new Error('Missing workspace fixture');
  await asAdmin(
    `alter table app.workspace_inbox_threads add constraint fold_retry_proof check(subject_id<>'${last.first}'::uuid or occurrence_count<=1) not valid`,
  );
  try {
    const refused: unknown = await fold
      .foldPending(1_000)
      .catch((error: unknown) => error);
    expect(refused instanceof AggregateError ? refused.errors : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: '23514',
          constraint: 'fold_retry_proof',
        }),
      ]),
    );
    for (const workspace of workspaces) {
      expect(await pending(workspace.workspaceId)).toBe(1);
      expect(await threads(workspace.workspaceId)).toEqual([
        expect.objectContaining({ occurrence_count: '1' }),
      ]);
    }
  } finally {
    await asAdmin(
      'alter table app.workspace_inbox_threads drop constraint fold_retry_proof',
    );
  }
  await fold.foldPending(1_000);
  for (const workspace of workspaces) {
    expect(await pending(workspace.workspaceId)).toBe(0);
    expect(await threads(workspace.workspaceId)).toEqual([
      expect.objectContaining({ occurrence_count: '2' }),
    ]);
  }
  expect(await fold.foldPending(1_000)).toEqual([]);
});

it('skips another claim and returns its rolled-back events to the next fold', async () => {
  const workspace = await seed();
  for (let i = 0; i < 3; i++)
    await fail(workspace.workspaceId, workspace.first);
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  const blocker = await pool.connect();
  try {
    await blocker.query('begin');
    const claimed = await blocker.query<{ workspace_id: string }>(
      'select * from app.claim_workspace_inbox_events(1)',
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]?.workspace_id).toBe(workspace.workspaceId);
    await fold.foldPending(1_000);
    expect(await pending(workspace.workspaceId)).toBe(1);
    expect(await threads(workspace.workspaceId)).toEqual([
      expect.objectContaining({ occurrence_count: '2' }),
    ]);
  } finally {
    await blocker.query('rollback');
    blocker.release();
    await pool.end();
  }
  await fold.foldPending(1_000);
  expect(await pending(workspace.workspaceId)).toBe(0);
  expect(await threads(workspace.workspaceId)).toEqual([
    expect.objectContaining({ occurrence_count: '3' }),
  ]);
});

it('allows queue consumption only for the scoped worker, preserving actor and foreign rows', async () => {
  const first = await seed(),
    second = await seed();
  await fail(first.workspaceId, first.first);
  await fail(second.workspaceId, second.first);
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [first.workspaceId, first.members.owner],
    );
    expect(
      (await client.query('select id from app.workspace_inbox_events')).rows,
    ).toEqual([]);
    expect(
      (await client.query('delete from app.workspace_inbox_events')).rowCount,
    ).toBe(0);
    await expect(
      client.query('select * from app.claim_workspace_inbox_events(1)'),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');

    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      first.workspaceId,
    ]);
    expect(
      (
        await client.query(
          'delete from app.workspace_inbox_events where workspace_id=$1',
          [second.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          'select workspace_id from app.workspace_inbox_events',
        )
      ).rows,
    ).toEqual([{ workspace_id: first.workspaceId }]);
    expect(
      (await client.query('delete from app.workspace_inbox_events')).rowCount,
    ).toBe(1);
    await client.query('rollback');
    expect(await pending(first.workspaceId)).toBe(1);
    expect(await pending(second.workspaceId)).toBe(1);
  } finally {
    await client.query('rollback');
    client.release();
    await pool.end();
  }
  await fold.foldPending(1_000);
});
