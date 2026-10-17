import { expect, it } from 'vitest';
import { coordinatedEventHistorySchema } from '@pertexo/contracts';
import {
  fixture,
  key,
  store,
  counts,
  expireWindow,
  finishRuns,
  apiPool,
} from './fixtures.js';
it('serializes same-key races, preserves exact transport receipts, and counts each business event once', async () => {
  const f = await fixture({ mode: 'deduplicate', key, windowSeconds: 86400 });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.submit()),
  );
  expect(results.filter((r) => r.accepted)).toHaveLength(1);
  expect(
    results.filter((r) => 'coordinated' in r && r.outcome === 'deduplicated'),
  ).toHaveLength(7);
  expect(await counts(f)).toEqual({ runs: 1, events: 8, usage: 8 });
  const response = await f.submit('new', 'secret-business-input', 'transport');
  expect(await f.submit('new', 'secret-business-input', 'transport')).toEqual({
    ...response,
    replayed: true,
  });
  expect(await counts(f)).toEqual({ runs: 2, events: 9, usage: 9 });
  const history = coordinatedEventHistorySchema.parse(
    await store.history({ ...f, limit: 3 }),
  );
  expect(history.items).toHaveLength(3);
  expect(history.next).not.toBeNull();
  if (history.next === null) throw new Error('Missing older events cursor');
  const older = await store.history({
    ...f,
    limit: 100,
    before: history.next.receivedAt,
    beforeId: history.next.id,
  });
  expect(older.items).toHaveLength(6);
  expect(
    new Set([...older.items, ...history.items].map((r) => r.id)).size,
  ).toBe(9);
  const metadata = JSON.stringify(history);
  expect(metadata).not.toContain('secret-business-input');
  expect(metadata).not.toContain('keyHash');
});
it('isolates identical keys by workspace and expires fixed windows without extending them on duplicates', async () => {
  const a = await fixture({ mode: 'deduplicate', key, windowSeconds: 60 }),
    b = await fixture({ mode: 'deduplicate', key, windowSeconds: 60 });
  expect((await a.submit()).accepted).toBe(true);
  expect((await b.submit()).accepted).toBe(true);
  const before = await a.query(
    'select window_started_at,expires_at from app.trigger_event_windows',
  );
  expect(await a.submit()).toMatchObject({ outcome: 'deduplicated' });
  expect(
    await a.query(
      'select window_started_at,expires_at from app.trigger_event_windows',
    ),
  ).toEqual(before);
  await finishRuns(a);
  await expireWindow(a);
  expect((await a.submit()).accepted).toBe(true);
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      a.workspaceId,
    ]);
    expect(
      (
        await client.query(
          'select id from app.trigger_coordinated_events where workspace_id=$1',
          [b.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      client.query(
        'select key_hash from app.trigger_event_windows where workspace_id=$1',
        [b.workspaceId],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  } finally {
    await client.query('rollback');
    client.release();
  }
});
it('refuses malformed keys visibly without revealing them or starting a run', async () => {
  const f = await fixture({
    mode: 'deduplicate',
    key: { kind: 'run_input', path: '$.values.missing' },
    windowSeconds: 60,
  });
  expect(await f.submit('sensitive')).toMatchObject({
    accepted: false,
    coordinated: true,
    outcome: 'refused',
    reason: 'invalid_key',
  });
  expect(await counts(f)).toEqual({ runs: 0, events: 1, usage: 1 });
  expect(
    await f.query(
      'select input_ref,policy,key_id from app.trigger_coordinated_events',
    ),
  ).toEqual([{ input_ref: null, policy: null, key_id: null }]);
});
it('does not consume a token when F29 skips a run at concurrency', async () => {
  const f = await fixture({ mode: 'deduplicate', key, windowSeconds: 60 });
  await f.query(
    "insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')",
    [f.workspaceId, f.workflowId],
  );
  expect((await f.submit('a')).accepted).toBe(true);
  expect(await f.submit('b')).toMatchObject({
    skipped: true,
    reason: 'concurrency_limit',
  });
  await finishRuns(f);
  expect((await f.submit('b')).accepted).toBe(true);
  expect(
    await f.query(
      "select count(*)::int n from app.usage_events where category='trigger.skipped'",
    ),
  ).toEqual([{ n: 1 }]);
});
it('fails closed at the active-key bound without disturbing existing keys', async () => {
  const f = await fixture({ mode: 'deduplicate', key, windowSeconds: 60 });
  await f.submit('existing');
  await f.query(
    "insert into app.trigger_event_windows(id,workspace_id,workflow_id,node_id,policy_hash,key_hash,window_started_at,used_count,expires_at) select gen_random_uuid(),$1,$2,'form',repeat('a',64),lpad(to_hex(n),64,'0'),clock_timestamp(),0,clock_timestamp()+interval '1 hour' from generate_series(1,9999) n",
    [f.workspaceId, f.workflowId],
  );
  expect(await f.submit('new-key')).toMatchObject({
    outcome: 'refused',
    reason: 'coordination_full',
  });
  expect(await f.submit('existing')).toMatchObject({ outcome: 'deduplicated' });
});

it('discovers only bounded due identities without tenant payload and refuses invalid discovery sizes', async () => {
  const f = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  await f.submit('private-key', 'private-payload');
  await f.query(
    "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '1 second'",
  );
  const discovered = await apiPool.query<{
    workspace_id: string;
    event_id: string;
  }>('select * from app.discover_due_coordinated_events(1)');
  expect(discovered.rows).toHaveLength(1);
  expect(Object.keys(discovered.rows[0] ?? {}).sort()).toEqual([
    'event_id',
    'workspace_id',
  ]);
  for (const limit of [null, 0, 101])
    await expect(
      apiPool.query('select * from app.discover_due_coordinated_events($1)', [
        limit,
      ]),
    ).rejects.toMatchObject({ code: '22023' });
  const unscoped = await apiPool.query(
    'select input_ref from app.trigger_coordinated_events',
  );
  expect(unscoped.rows).toEqual([]);
});
