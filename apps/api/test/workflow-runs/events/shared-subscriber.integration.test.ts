import { randomUUID } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';

import { Redis } from 'ioredis';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  RedisRunEventSource,
  runEventChannel,
} from '../../../src/workflow-runs/events/redis-source.js';
import { RedisRunEventSubscribeError } from '../../../src/workflow-runs/events/redis-subscribe.js';
import { FixtureRedisProxy } from '../../rate-limit/integration.fixture.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.API_SSE_INTEGRATION === 'true';

/** A Redis that takes connections and answers nothing, until it's told to. */
async function createSilentRedis(target: URL) {
  const held: Socket[] = [];
  const sockets = new Set<Socket>();
  const track = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    return socket;
  };
  let silent = true;
  const forward = (client: Socket): void => {
    const upstream = track(connect(Number(target.port), target.hostname));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const server: Server = createServer((client) => {
    track(client);
    client.on('error', () => undefined);
    if (silent) held.push(client);
    else forward(client);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a port');
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    speak: () => {
      silent = false;
      for (const client of held.splice(0)) forward(client);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe.runIf(requested)(
  'one Redis subscriber shared by a process’s run streams',
  () => {
    const workspaceId = randomUUID();
    const url = redisUrl ?? 'redis://unused';
    let publisher: Redis;
    let proxy: FixtureRedisProxy;
    const closers: (() => Promise<unknown>)[] = [];

    beforeAll(async () => {
      publisher = new Redis(url, { maxRetriesPerRequest: 1 });
      await publisher.ping();
      proxy = await FixtureRedisProxy.create(url);
    });

    afterAll(async () => {
      await publisher.quit();
      await proxy.close();
    });

    afterEach(async () => {
      for (const close of closers.splice(0)) await close();
    });

    const sourceOn = (through: string, subscribeTimeoutMs?: number) =>
      new RedisRunEventSource({
        redisUrl: through,
        ...(subscribeTimeoutMs === undefined ? {} : { subscribeTimeoutMs }),
      });

    const open = async (
      source: RedisRunEventSource,
      runId: string,
      signal = new AbortController().signal,
    ) => {
      const subscription = await source.subscribe({
        workspaceId,
        runId,
        signal,
      });
      closers.push(() => subscription.close());
      const iterator = subscription[Symbol.asyncIterator]();
      return {
        close: () => subscription.close(),
        next: async () => (await iterator.next()).value as unknown,
      };
    };

    const eventFor = (runId: string, sequence = 1) => ({
      kind: 'event',
      runId,
      sequence,
      workspaceId,
    });

    const publish = (runId: string, sequence = 1) =>
      publisher.publish(
        runEventChannel(workspaceId, runId),
        JSON.stringify(eventFor(runId, sequence)),
      );

    /** How many connections Redis says are listening on this run's channel. */
    const subscribersOf = async (runId: string): Promise<number> => {
      const channel = runEventChannel(workspaceId, runId);
      const reply = (await publisher.call('PUBSUB', 'NUMSUB', channel)) as [
        string,
        number,
      ];
      return reply[1];
    };

    it('keeps two runs’ streams apart, on one connection', async () => {
      const source = sourceOn(proxy.url);
      const [runA, runB] = [randomUUID(), randomUUID()];

      const streamA = await open(source, runA);
      const streamB = await open(source, runB);

      expect(proxy.connectionCount).toBe(1);
      await publish(runB, 7);
      await publish(runA, 3);
      await expect(streamB.next()).resolves.toEqual(eventFor(runB, 7));
      await expect(streamA.next()).resolves.toEqual(eventFor(runA, 3));
    });

    it('gives each of two pages on one run its own copy', async () => {
      const source = sourceOn(proxy.url);
      const runId = randomUUID();
      const first = await open(source, runId);
      const second = await open(source, runId);

      expect(await subscribersOf(runId)).toBe(1);
      await publish(runId, 5);

      await expect(first.next()).resolves.toEqual(eventFor(runId, 5));
      await expect(second.next()).resolves.toEqual(eventFor(runId, 5));
    });

    it('tells every open stream to re-read after a lost connection, and carries on', async () => {
      const source = sourceOn(proxy.url);
      const [runA, runB] = [randomUUID(), randomUUID()];
      const streamA = await open(source, runA);
      const twinA = await open(source, runA);
      const streamB = await open(source, runB);

      expect(proxy.disconnectClients()).toBeGreaterThan(0);

      for (const stream of [streamA, twinA, streamB])
        await expect(stream.next()).resolves.toEqual({ kind: 'resync' });
      await vi.waitFor(async () => {
        expect(await subscribersOf(runA)).toBe(1);
        expect(await subscribersOf(runB)).toBe(1);
      });
      await publish(runB, 9);
      await expect(streamB.next()).resolves.toEqual(eventFor(runB, 9));
    });

    it('lets a run’s channel go when its last page closes, and keeps the others', async () => {
      const source = sourceOn(proxy.url);
      const [runA, runB] = [randomUUID(), randomUUID()];
      const first = await open(source, runA);
      const second = await open(source, runA);
      const other = await open(source, runB);

      await first.close();
      expect(await subscribersOf(runA)).toBe(1);
      await publish(runA, 2);
      await expect(second.next()).resolves.toEqual(eventFor(runA, 2));

      await second.close();
      await vi.waitFor(async () => {
        expect(await subscribersOf(runA)).toBe(0);
      });
      expect(await subscribersOf(runB)).toBe(1);
      await publish(runB, 4);
      await expect(other.next()).resolves.toEqual(eventFor(runB, 4));
    });

    it('closes the connection with the last stream, and opens a new one for the next', async () => {
      const source = sourceOn(proxy.url);
      const runId = randomUUID();
      const only = await open(source, runId);
      expect(proxy.connectionCount).toBe(1);

      await only.close();

      await vi.waitFor(() => {
        expect(proxy.connectionCount).toBe(0);
      });
      const again = await open(source, runId);
      expect(proxy.connectionCount).toBe(1);
      await publish(runId, 6);
      await expect(again.next()).resolves.toEqual(eventFor(runId, 6));
    });

    // Each page waits on the same subscribe, so one giving up mustn't end it for the other.
    it('fails both pages waiting on a subscribe that times out, then works on the next try', async () => {
      const silent = await createSilentRedis(new URL(url));
      closers.push(() => silent.close());
      const source = sourceOn(silent.url, 2_000);
      const runId = randomUUID();

      const outcomes = await Promise.allSettled([
        source.subscribe({
          workspaceId,
          runId,
          signal: new AbortController().signal,
        }),
        source.subscribe({
          workspaceId,
          runId,
          signal: new AbortController().signal,
        }),
      ]);

      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason).toMatchObject({
          reason: 'timeout',
        });
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
          RedisRunEventSubscribeError,
        );
      }

      silent.speak();
      const retried = await open(source, runId);
      await publish(runId, 8);
      await expect(retried.next()).resolves.toEqual(eventFor(runId, 8));
    });

    it('keeps a second page waiting when the first gives up on the same subscribe', async () => {
      const silent = await createSilentRedis(new URL(url));
      closers.push(() => silent.close());
      const source = sourceOn(silent.url, 10_000);
      const runId = randomUUID();
      const leaving = new AbortController();

      const first = source.subscribe({
        workspaceId,
        runId,
        signal: leaving.signal,
      });
      const second = source.subscribe({
        workspaceId,
        runId,
        signal: new AbortController().signal,
      });
      leaving.abort();
      await expect(first).rejects.toMatchObject({ reason: 'aborted' });

      silent.speak();

      const stream = await second;
      closers.push(() => stream.close());
      await publish(runId, 11);
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: eventFor(runId, 11),
      });
    });

    it('drops a malformed message and delivers the next good one', async () => {
      const source = sourceOn(proxy.url);
      const runId = randomUUID();
      const stream = await open(source, runId);
      const channel = runEventChannel(workspaceId, runId);

      await publisher.publish(channel, '{not json');
      await publisher.publish(channel, JSON.stringify({ kind: 'event' }));
      await publish(runId, 12);

      await expect(stream.next()).resolves.toEqual(eventFor(runId, 12));
    });
  },
);
