import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  fixture,
  key,
  scan,
  due,
  expireWindow,
  counts,
  queryAsOwner,
  finishRuns,
  store,
  enforceTestRetention,
  purgeTestWorkspace,
} from './fixtures.js';
it('keeps queue-full events pending without consuming tokens, admits after capacity frees and refuses visibly after 15 minutes', async () => {
  const f = await fixture({
    mode: 'throttle',
    key,
    windowSeconds: 60,
    limit: 1,
    onExcess: 'delay',
  });
  await f.submit('same', 'first');
  await f.submit('same', 'second');
  await queryAsOwner(
    "insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at) values($1,2,'active',1,1,'-infinity')",
    [f.workspaceId],
    f.workspaceId,
  );
  await queryAsOwner(
    'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
    [f.workspaceId],
    f.workspaceId,
  );
  await expireWindow(f);
  await due(f);
  await scan();
  expect(
    await f.query(
      "select status,reason,input_ref is not null retained,capacity_wait_started_at is not null waiting from app.trigger_coordinated_events where status='pending'",
    ),
  ).toEqual([
    { status: 'pending', reason: 'queue_full', retained: true, waiting: true },
  ]);
  expect(
    await f.query('select used_count from app.trigger_event_windows'),
  ).toEqual([{ used_count: 1 }]);
  await finishRuns(f);
  await due(f);
  await scan();
  expect((await counts(f))?.runs).toBe(2);
  await f.submit('same', 'third');
  await expireWindow(f);
  await due(f);
  await scan();
  await f.query(
    "update app.trigger_coordinated_events set capacity_wait_started_at=clock_timestamp()-interval '16 minutes',due_at=clock_timestamp()-interval '1 second' where status='pending'",
  );
  await scan();
  expect(
    await f.query(
      "select reason,input_ref,policy from app.trigger_coordinated_events where status='refused'",
    ),
  ).toEqual([{ reason: 'queue_full', input_ref: null, policy: null }]);
});
it('bounds pending event count and bytes, retains the previous input on a refused debounce replacement', async () => {
  const f = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  await f.submit('same', 'original');
  await f.query(
    "insert into app.trigger_coordinated_events(id,workspace_id,workflow_id,node_id,source,mode,initial_outcome,initial_status,status,version_number,key_id,workflow_version_id,policy,input_ref,input_bytes,due_at,deadline_at) select gen_random_uuid(),workspace_id,workflow_id,node_id,source,'throttle','throttled','pending','pending',version_number,key_id,workflow_version_id,policy,input_ref,input_bytes,due_at,deadline_at from app.trigger_coordinated_events cross join generate_series(1,999) n where status='pending'",
  );
  expect(await f.submit('other', 'refused')).toMatchObject({
    outcome: 'refused',
    reason: 'coordination_full',
  });
  expect(await f.submit('same', 'replacement')).toMatchObject({
    outcome: 'debounced',
    status: 'pending',
  });
  await f.query(
    "update app.trigger_coordinated_events set input_bytes=262144 where status='pending'",
  );
  expect(await f.submit('same', 'larger')).toMatchObject({
    outcome: 'refused',
    reason: 'coordination_full',
  });
  expect(
    await f.query(
      "select count(*)::int n from app.trigger_coordinated_events where status='pending' and input_ref->'value'->'values'->>'message'='replacement'",
    ),
  ).toEqual([{ n: 1 }]);
});
it('expires metadata on reads before maintenance and purges both state tables without blocking versions or runs', async () => {
  const f = await fixture({ mode: 'deduplicate', key, windowSeconds: 60 });
  await f.submit();
  await f.submit();
  await finishRuns(f);
  await f.query(
    "update app.trigger_coordinated_events set received_at=clock_timestamp()-interval '91 days',expires_at=clock_timestamp()-interval '1 day'",
  );
  expect((await store.history({ ...f, limit: 25 })).items).toEqual([]);
  await enforceTestRetention(50);
  expect(
    await f.query('select count(*)::int n from app.trigger_coordinated_events'),
  ).toEqual([{ n: 0 }]);
  const pending = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  await pending.submit('pending', 'private-retained');
  await purgeTestWorkspace(pending.workspaceId);
  expect(
    await queryAsOwner(
      'select id from app.trigger_coordinated_events where workspace_id=$1',
      [pending.workspaceId],
      pending.workspaceId,
    ),
  ).toEqual([]);
  expect(
    await queryAsOwner(
      'select id from app.trigger_event_windows where workspace_id=$1',
      [pending.workspaceId],
      pending.workspaceId,
    ),
  ).toEqual([]);
});
it('returns no coordination history for a foreign workflow identity', async () => {
  const f = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  await f.submit();
  const [event] = await f.query<{ id: string }>(
    'select id from app.trigger_coordinated_events',
  );
  expect(event?.id).toBeDefined();
  expect(
    await store.history({ ...f, workflowId: randomUUID(), limit: 25 }),
  ).toMatchObject({ items: [] });
});
