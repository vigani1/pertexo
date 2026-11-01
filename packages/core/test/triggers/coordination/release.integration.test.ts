import { expect, it } from 'vitest';
import { createTriggerEventScanner } from '../../../src/triggers/coordination/scanner.repository.js';
import {
  fixture,
  key,
  scan,
  due,
  expireWindow,
  counts,
  config,
  checkpointFactory,
  finishRuns,
} from './fixtures.js';
it('debounces to the latest complete input, clears replaced payloads and preserves original replay receipts', async () => {
  const f = await fixture({ mode: 'debounce', key, quietSeconds: 3600 });
  const first = await f.submit('same', 'first', 'retry');
  const second = await f.submit('same', 'latest');
  expect(first).toMatchObject({ outcome: 'debounced', status: 'pending' });
  expect(second).toMatchObject({ status: 'pending' });
  expect(
    await f.query(
      "select status,input_ref,key_id from app.trigger_coordinated_events where status='coalesced'",
    ),
  ).toEqual([{ status: 'coalesced', input_ref: null, key_id: null }]);
  const before = await f.query(
    "select id,due_at from app.trigger_coordinated_events where status='pending'",
  );
  expect(await f.submit('same', 'first', 'retry')).toEqual({
    ...first,
    replayed: true,
  });
  expect(
    await f.query(
      "select id,due_at from app.trigger_coordinated_events where status='pending'",
    ),
  ).toEqual(before);
  await due(f);
  const restarted = createTriggerEventScanner(config);
  try {
    await Promise.all([
      scan(),
      restarted.scanDue({ limit: 100, checkpointFactory }),
    ]);
  } finally {
    await restarted.close();
  }
  expect(await counts(f)).toEqual({ runs: 1, events: 2, usage: 2 });
  expect(
    await f.query(
      'select input_ref from app.workflow_runs where workflow_id=$1',
      [f.workflowId],
    ),
  ).toMatchObject([
    { input_ref: { value: { values: { message: 'latest' } } } },
  ]);
  expect(
    await f.query(
      "select input_ref,policy,key_id,workflow_version_id,due_at from app.trigger_coordinated_events where status='started'",
    ),
  ).toEqual([
    {
      input_ref: null,
      policy: null,
      key_id: null,
      workflow_version_id: null,
      due_at: null,
    },
  ]);
  expect(await f.submit('same', 'first', 'retry')).toEqual({
    ...first,
    replayed: true,
  });
});
it('throttles by fixed windows and delays in FIFO order with tokens charged only on admission', async () => {
  const f = await fixture({
    mode: 'throttle',
    key,
    windowSeconds: 60,
    limit: 1,
    onExcess: 'delay',
  });
  expect((await f.submit('same', 'first')).accepted).toBe(true);
  expect(await f.submit('same', 'second')).toMatchObject({
    outcome: 'throttled',
    status: 'pending',
  });
  expect(await f.submit('same', 'third')).toMatchObject({ status: 'pending' });
  await due(f);
  await scan();
  expect((await counts(f))?.runs).toBe(1);
  await expireWindow(f);
  await due(f);
  await scan();
  expect((await counts(f))?.runs).toBe(2);
  expect(
    await f.query(
      "select input_ref from app.trigger_coordinated_events where status='pending'",
    ),
  ).toMatchObject([{ input_ref: { value: { values: { message: 'third' } } } }]);
  await due(f);
  await scan();
  expect((await counts(f))?.runs).toBe(2);
  await expireWindow(f);
  await due(f);
  await scan();
  expect((await counts(f))?.runs).toBe(3);
  expect(
    await f.query('select used_count from app.trigger_event_windows'),
  ).toEqual([{ used_count: 1 }]);
});
it('skips throttle excess without retaining input and starts after expiry', async () => {
  const f = await fixture({
    mode: 'throttle',
    key,
    windowSeconds: 60,
    limit: 1,
    onExcess: 'skip',
  });
  await f.submit();
  expect(await f.submit()).toMatchObject({
    outcome: 'throttled',
    status: 'skipped',
    reason: 'throttle_limit',
  });
  expect(
    await f.query(
      "select input_ref from app.trigger_coordinated_events where status='skipped'",
    ),
  ).toEqual([{ input_ref: null }]);
  await finishRuns(f);
  await expireWindow(f);
  expect((await f.submit()).accepted).toBe(true);
});
it.each(['publication', 'archive', 'pause', 'expiry'] as const)(
  'refuses a pending event after %s without leaving its input',
  async (change) => {
    const f = await fixture({ mode: 'debounce', key, quietSeconds: 1 });
    await f.submit();
    if (change === 'publication')
      await f.query(
        'update app.workflows set published_version_id=null where id=$1',
        [f.workflowId],
      );
    if (change === 'archive')
      await f.query(
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [f.workflowId],
      );
    if (change === 'pause') {
      const [run] = await f.query<{ id: string }>(
        "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at) values(gen_random_uuid(),$1,$2,$3,'form','failed',clock_timestamp()) returning id",
        [f.workspaceId, f.workflowId, f.versionId],
      );
      if (run === undefined) throw new Error('Missing failed run');
      await f.query(
        "update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),trigger_pause_reason='consecutive_failures',trigger_pause_failures=5,trigger_pause_last_run_id=$2 where id=$1",
        [f.workflowId, run.id],
      );
    }
    if (change === 'expiry')
      await f.query(
        "update app.trigger_coordinated_events set received_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()+interval '88 days',deadline_at=clock_timestamp()-interval '1 day',due_at=clock_timestamp()-interval '1 day'",
      );
    await due(f);
    await scan();
    expect((await counts(f))?.runs).toBe(change === 'pause' ? 1 : 0);
    let refusalReason;
    if (change === 'publication') {
      refusalReason = 'publication_changed';
    } else {
      if (change === 'expiry') {
        refusalReason = 'coordination_timeout';
      } else {
        refusalReason = 'workflow_unavailable';
      }
    }
    expect(
      await f.query(
        'select status,reason,input_ref from app.trigger_coordinated_events',
      ),
    ).toEqual([
      {
        status: 'refused',
        reason: refusalReason,
        input_ref: null,
      },
    ]);
  },
);
it('rechecks F29 at deferred admission and records a visible concurrency skip', async () => {
  const f = await fixture({ mode: 'debounce', key, quietSeconds: 1 });
  await f.query(
    "insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')",
    [f.workspaceId, f.workflowId],
  );
  await f.submit('a');
  await f.submit('b');
  await due(f);
  await scan();
  expect((await counts(f))?.runs).toBe(1);
  expect(
    await f.query(
      "select reason from app.trigger_coordinated_events where status='skipped'",
    ),
  ).toEqual([{ reason: 'concurrency_limit' }]);
});
