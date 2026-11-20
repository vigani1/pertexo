import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { pollingFixture } from './polling.fixture.js';

let poll: ReturnType<typeof pollingFixture>;

beforeEach(async () => {
  poll = pollingFixture();
  await poll.initialize();
});
afterEach(() => poll.close());

const feed = (...keys: (string | number)[]) =>
  keys.map((key) => ({ key, item: { key } }));
const fakeFeed =
  (...keys: (string | number)[]) =>
  () =>
    Promise.resolve(feed(...keys));
const digest = (key: string | number) =>
  createHash('sha256').update(JSON.stringify(key)).digest('hex');
const admitted = (...keys: (string | number)[]) =>
  keys.map((key) => ({ item: { key }, outbox: 1 }));

async function emptyBaseline() {
  const publication = await poll.publish();
  await poll.scanner(fakeFeed())();
  expect(await poll.read(publication.triggerId)).toMatchObject({
    hashes: [],
    due: false,
    leased: false,
    health: 'healthy',
  });
  await poll.makeDue(publication.triggerId);
  return publication;
}

it('baselines distinct keys in reverse feed order and preserves progress when reconciling the same version', async () => {
  const first = await poll.publish();
  expect(await poll.read(first.triggerId)).toMatchObject({
    hashes: null,
    due: true,
    health: 'pending',
  });
  await poll.scanner(fakeFeed('1', 1, '1', 'oldest'))();
  expect(await poll.read(first.triggerId)).toMatchObject({
    hashes: ['oldest', 1, '1'].map(digest),
    health: 'healthy',
    due: false,
  });
  await first.reconcile();
  expect(await poll.read(first.triggerId)).toMatchObject({
    hashes: ['oldest', 1, '1'].map(digest),
    due: false,
  });
  const next = await poll.publish();
  expect(await poll.read(first.triggerId)).toMatchObject({
    retired: true,
    leased: false,
  });
  expect(await poll.read(next.triggerId)).toMatchObject({
    hashes: null,
    due: true,
  });
  await poll.scanner(fakeFeed())();
  expect(await poll.read(next.triggerId)).toMatchObject({
    hashes: [],
    due: false,
  });
  expect(await poll.admitted()).toEqual([]);
});

it('refetches after cancellation before admission and admits each item once in reverse feed order', async () => {
  const { triggerId } = await emptyBaseline();
  const controller = new AbortController();
  const scan = poll.scanner(() => {
    controller.abort();
    return Promise.resolve(feed('new', 'old'));
  });
  await expect(scan({ signal: controller.signal })).rejects.toThrow();
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [],
    leased: false,
  });
  expect(await poll.admitted()).toEqual([]);
  await poll.scanner(fakeFeed('new', 'old'))();
  expect(await poll.admitted()).toEqual(admitted('old', 'new'));
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: ['old', 'new'].map(digest),
  });
});

it('resumes after the first committed item without delivering it twice', async () => {
  const { triggerId } = await emptyBaseline();
  const scan = poll.scanner(fakeFeed('third', 'second', 'first'));
  let checkpoints = 0;
  await expect(
    scan({
      checkpointFactory: (projection) => {
        if (++checkpoints === 2) throw new Error('injected interruption');
        return poll.checkpointFactory(projection);
      },
    }),
  ).rejects.toThrow('injected interruption');
  expect(await poll.admitted()).toEqual(admitted('first'));
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [digest('first')],
    leased: false,
  });
  await scan();
  expect(await poll.admitted()).toEqual(admitted('first', 'second', 'third'));
});

it('rolls back admission and outbox work if the seen-set write fails', async () => {
  const { triggerId } = await emptyBaseline();
  await poll.ownerQuery(`
    create function app.fail_poll_append() returns trigger language plpgsql as $$
      begin raise exception 'injected poll append failure'; end; $$;
    create trigger fail_poll_append before update of seen_keys on app.trigger_polls
      for each row execute function app.fail_poll_append()
  `);
  const scan = poll.scanner(fakeFeed('retry'));
  await expect(scan()).rejects.toThrow();
  expect(await poll.admitted()).toEqual([]);
  expect(await poll.deliveries()).toBe(0);
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [],
    leased: false,
  });
  await poll.ownerQuery('drop trigger fail_poll_append on app.trigger_polls');
  await scan();
  expect(await poll.admitted()).toEqual(admitted('retry'));
  expect(await poll.deliveries()).toBe(1);
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [digest('retry')],
  });
});

it.each(['quota', 'concurrency'])(
  'leaves the rest of a batch unseen when %s is full',
  async (capacity) => {
    const { triggerId } = await emptyBaseline();
    if (capacity === 'quota') {
      await poll.ownerQuery(
        `insert into app.workspace_execution_entitlement_versions
       (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,1,'-infinity')`,
        [poll.workspaceId],
      );
      await poll.ownerQuery(
        'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
        [poll.workspaceId],
      );
    } else {
      await poll.ownerQuery(
        `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow)
       values($1,$2,1,'skip')`,
        [poll.workspaceId, poll.workflowId],
      );
    }
    const scan = poll.scanner(fakeFeed('third', 'second', 'first'));
    expect(await scan()).toMatchObject({ deferred: 1 });
    expect(await poll.read(triggerId)).toMatchObject({
      hashes: [digest('first')],
      leased: false,
      due: false,
    });
    expect(await poll.admitted()).toEqual(admitted('first'));
    expect(await scan()).toMatchObject({ claimed: 0 });
    if (capacity === 'quota')
      await poll.ownerQuery(
        'update app.workspace_execution_entitlements set current_version=1 where workspace_id=$1',
        [poll.workspaceId],
      );
    else
      await poll.ownerQuery(
        'delete from app.workflow_concurrency_policies where workflow_id=$1',
        [poll.workflowId],
      );
    await poll.makeDue(triggerId);
    await scan();
    expect(await poll.admitted()).toEqual(admitted('first', 'second', 'third'));
  },
);

it('fences an expired worker while a replacement lease is held', async () => {
  const { triggerId } = await poll.publish();
  const firstReady = Promise.withResolvers<undefined>();
  const allowFirst = Promise.withResolvers<undefined>();
  const secondReady = Promise.withResolvers<undefined>();
  const allowSecond = Promise.withResolvers<undefined>();
  const first = poll.scanner(async () => {
    firstReady.resolve(undefined);
    await allowFirst.promise;
    return feed('stale');
  })();
  await Promise.race([firstReady.promise, first]);
  try {
    await poll.ownerQuery(
      `update app.trigger_polls set
      lease_acquired_at=clock_timestamp()-interval '2 seconds',
      lease_expires_at=clock_timestamp()-interval '1 second' where trigger_id=$1`,
      [triggerId],
    );
    const second = poll.scanner(async () => {
      secondReady.resolve(undefined);
      await allowSecond.promise;
      return feed('current');
    })();
    try {
      await Promise.race([secondReady.promise, second]);
      allowFirst.resolve(undefined);
      await first;
      expect(await poll.read(triggerId)).toMatchObject({
        hashes: null,
        leased: true,
        health: 'pending',
      });
    } finally {
      allowSecond.resolve(undefined);
      await second;
    }
  } finally {
    allowFirst.resolve(undefined);
    await first;
  }
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [digest('current')],
    leased: false,
    health: 'healthy',
  });
  expect(await poll.admitted()).toEqual([]);
});

it.each(['publication', 'pause'])(
  'fences progress and health after a %s change during fetch',
  async (change) => {
    const { triggerId } = await poll.publish();
    const scan = poll.scanner(async () => {
      if (change === 'publication') await poll.publish(false);
      else
        await poll.ownerQuery(
          `update app.workflows set trigger_pause_state='paused',
      trigger_paused_at=clock_timestamp(), trigger_pause_reason='consecutive_failures',
      trigger_pause_failures=10, trigger_pause_last_run_id=gen_random_uuid(),
      trigger_pause_revision=trigger_pause_revision+1 where id=$1`,
          [poll.workflowId],
        );
      return feed('stale');
    });
    await scan();
    expect(await poll.read(triggerId)).toMatchObject({
      hashes: null,
      health: 'pending',
      leased: false,
    });
    expect(await poll.admitted()).toEqual([]);
  },
);

it('isolates poll reads and writes by workspace and keeps claim access on the maintenance role', async () => {
  const { triggerId } = await poll.publish();
  await withTenantScopedClient(
    poll.app,
    { workspaceId: randomUUID() },
    async (client) => {
      const read = await client.query(
        'select seen_keys from app.trigger_polls where trigger_id=$1',
        [triggerId],
      );
      expect(read.rows).toEqual([]);
      const update = await client.query(
        'update app.trigger_polls set seen_keys=array[]::bytea[] where trigger_id=$1',
        [triggerId],
      );
      expect(update.rowCount).toBe(0);
    },
  );
  await withTenantScopedClient(
    poll.app,
    { workspaceId: poll.workspaceId },
    (client) =>
      expect(
        client.query(
          "select * from app.claim_due_trigger_polls('no-access',1,30)",
        ),
      ).rejects.toMatchObject({ code: '42501' }),
  );
  expect(await poll.read(triggerId)).toMatchObject({ hashes: null });
});

it('evicts the oldest recorded keys and uses the admission receipt after eviction', async () => {
  const { triggerId } = await emptyBaseline();
  await poll.scanner(fakeFeed('original'))();
  const retained = Array.from({ length: 999 }, (_, index) => digest(index));
  await poll.ownerQuery(
    `update app.trigger_polls set seen_keys=seen_keys||
       array(select decode(entry,'hex') from unnest($2::text[]) entry) where trigger_id=$1`,
    [triggerId, retained],
  );
  await poll.makeDue(triggerId);
  await poll.scanner(fakeFeed('original', 0, 'new'))();
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [...retained, digest('new')],
  });
  await poll.makeDue(triggerId);
  await poll.scanner(() =>
    Promise.resolve([{ key: 'original', item: { changed: true } }]),
  )({
    checkpointFactory: () => {
      throw new Error('replay should not prepare a checkpoint');
    },
  });
  expect(await poll.admitted()).toEqual(admitted('original', 'new'));
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: [...retained.slice(1), digest('new'), digest('original')],
  });
  await poll.ownerQuery(
    "update app.trigger_polls set seen_keys=array_remove(seen_keys,decode($2,'hex')) where trigger_id=$1",
    [triggerId, digest('original')],
  );
  await poll.ownerQuery('delete from app.idempotency_records where scope=$1', [
    `polling:${triggerId}`,
  ]);
  await poll.makeDue(triggerId);
  await poll.scanner(fakeFeed('original'))();
  expect(await poll.admitted()).toEqual(
    admitted('original', 'new', 'original'),
  );
});
