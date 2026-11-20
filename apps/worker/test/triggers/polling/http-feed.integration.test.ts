import { beforeEach, expect, it, onTestFinished } from 'vitest';
import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { pollingFixture } from '../../../../../packages/core/test/triggers/polling/polling.fixture.js';
import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { createPollingHttpRuntime } from '../../../src/triggers/polling-http.runtime.js';
import { json, server } from '../../integrations/support/pagination.js';

type Page = Readonly<{ items: unknown; next?: string }>;

let poll: ReturnType<typeof pollingFixture>;
let runtime: Awaited<ReturnType<typeof createPollingHttpRuntime>>;

beforeEach(async () => {
  poll = pollingFixture();
  onTestFinished(() => poll.close());
  await poll.initialize();
  runtime = await createPollingHttpRuntime({
    addressPolicy: {
      allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
    },
    database: poll.config,
    redisUrl: testStackSetting('REDIS_URL'),
    workerId: 'poll-worker',
    shutdownTimeoutMillis: 5_000,
  });
  onTestFinished(() => runtime.close());
});

const feed = (...keys: (string | number)[]) => keys.map((key) => ({ key }));
const runs = (...keys: (string | number)[]) =>
  keys.map((key) => ({ item: { key }, outbox: 1 }));

async function scenario(initial: Readonly<Record<string, Page>>) {
  const requests: string[] = [];
  let pages = initial;
  const origin = await server((url, _request, response) => {
    requests.push(url.pathname);
    const page = pages[url.pathname];
    if (page === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (page.next !== undefined)
      response.setHeader('link', `<${page.next}>; rel="next"`);
    json(response, page.items);
  });
  const { triggerId } = await poll.publish(true, `${origin}/items`);
  const scan = poll.scanner(runtime.fetchPoll);
  return {
    scan,
    requests,
    state: () => poll.read(triggerId),
    next: async (updated: typeof initial) => {
      requests.length = 0;
      pages = updated;
      await poll.makeDue(triggerId);
      return scan();
    },
  };
}

it('baselines five linked pages and admits the first copy of each new typed key after deletion and reordering', async () => {
  const observation = await scenario({
    '/items': { items: feed('old-head'), next: '/2' },
    '/2': { items: feed('deleted'), next: '/3' },
    '/3': { items: feed('old-middle'), next: '/4' },
    '/4': { items: feed('old-next'), next: '/5' },
    '/5': { items: feed('old-tail'), next: '/6' },
    '/6': { items: feed('beyond-page-cap') },
  });
  await observation.scan();
  expect(observation.requests).toEqual(['/items', '/2', '/3', '/4', '/5']);
  expect((await observation.state())?.hashes).toHaveLength(5);
  expect(await poll.admitted()).toEqual([]);

  await observation.next({
    '/items': {
      items: [
        ...feed('old-tail', '1', 'old-middle', 1),
        { key: '1', ignored: true },
      ],
      next: '/2',
    },
    '/2': { items: feed('old-next', 'old-head'), next: '/3' },
    '/3': { items: feed('beyond-page-cap') },
  });
  expect(observation.requests).toEqual(['/items', '/2']);
  expect(await poll.admitted()).toEqual(runs(1, '1'));
  expect((await observation.state())?.hashes).toHaveLength(7);
});

it.each(['exactly fits', 'overflows'] as const)(
  'stops requesting and inspecting at the item cap when the last page %s',
  async (lastPage) => {
    const observation = await scenario({ '/items': { items: [] } });
    await observation.scan();
    // Repeated keys count toward the cap. Only the first copy starts a run.
    const repeatKeys: string[] = Array.from({ length: 99 }, () => 'repeat');
    await observation.next({
      '/items': { items: feed(...repeatKeys), next: '/2' },
      '/2': {
        items:
          lastPage === 'exactly fits'
            ? feed('last')
            : [...feed('last', 'beyond-item-cap'), { invalid: true }],
        next: '/3',
      },
      '/3': { items: feed('beyond-last-page') },
    });
    expect(observation.requests).toEqual(['/items', '/2']);
    expect(await poll.admitted()).toEqual(runs('last', 'repeat'));
    expect((await observation.state())?.hashes).toHaveLength(2);
  },
);

it.each([
  { items: { key: 'private' }, code: 'http.poll_invalid_items' },
  { items: [{ key: true }], code: 'http.poll_invalid_key' },
  { items: [{ key: '' }], code: 'http.poll_invalid_key' },
])(
  'releases the poll without recording partial progress on $code',
  async ({ items, code }) => {
    const observation = await scenario({ '/items': { items: feed('seen') } });
    await observation.scan();
    const hashes = (await observation.state())?.hashes;

    await expect(
      observation.next({
        '/items': { items: feed('new'), next: '/2' },
        '/2': { items },
      }),
    ).rejects.toMatchObject({ message: `HTTP poll failed: ${code}`, code });
    expect(observation.requests).toEqual(['/items', '/2']);
    expect(await observation.state()).toMatchObject({
      hashes,
      leased: false,
      due: true,
      health: 'healthy',
    });
    expect(await poll.admitted()).toEqual([]);
  },
);

it('rejects cross-origin next links without dispatch or changes to seen state', async () => {
  const observation = await scenario({ '/items': { items: feed('seen') } });
  await observation.scan();
  const hashes = (await observation.state())?.hashes;
  const deniedRequests: string[] = [];
  const otherOrigin = await server((url, _request, response) => {
    deniedRequests.push(url.pathname);
    json(response, feed('elsewhere'));
  });

  await expect(
    observation.next({
      '/items': { items: feed('new'), next: `${otherOrigin}/private` },
    }),
  ).rejects.toMatchObject({
    code: 'http.poll_navigation_denied',
    message: 'HTTP poll failed: http.poll_navigation_denied',
  });
  expect(deniedRequests).toEqual([]);
  expect(await observation.state()).toMatchObject({
    hashes,
    leased: false,
    due: true,
    health: 'healthy',
  });
  expect(await poll.admitted()).toEqual([]);
});
