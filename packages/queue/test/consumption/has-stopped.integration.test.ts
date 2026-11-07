import { randomUUID } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';

import { Worker } from 'bullmq';
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

import { createQueueConsumer, type QueueConsumer } from '../../src/consumer.js';
import { JOB_NAME, QUEUE_NAME } from '../../src/jobs/names.js';
import { createQueueProducer } from '../../src/producer.js';

const redisUrl = process.env.REDIS_URL;
const requested = process.env.QUEUE_INTEGRATION === 'true';
if (requested && (redisUrl === undefined || redisUrl.trim() === ''))
  throw new Error('Queue integration requires REDIS_URL');
const describeIntegration = requested ? describe : describe.skip;

/** A database index of this file's own: queue names are fixed, so jobs would mix. */
const OWN_DATABASE = 13;

/**
 * Redis as a consumer sees it during an outage: connections drop and new ones are
 * refused. It sits in front of the real server, so stopping that isn't needed, and
 * nothing else using it notices.
 */
async function createCuttableRedis(target: URL) {
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  };
  const listen = (server: Server, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    track(client);
    track(upstream);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected the stand-in to listen on a port');
  const { port } = address;
  const cut = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return {
    url: url.toString(),
    cut,
    restore: () => listen(server, port),
  };
}

describeIntegration('whether a real queue consumer has stopped', () => {
  const direct = new URL(redisUrl ?? 'redis://unused');
  direct.pathname = `/${String(OWN_DATABASE)}`;
  let cleaner: Redis;
  let consumer: QueueConsumer | undefined;

  const open = (
    url: string,
    handler: () => Promise<void> = () => Promise.resolve(),
    connectionErrors: { count: number } = { count: 0 },
  ): QueueConsumer => {
    consumer = createQueueConsumer({
      handler,
      queueName: QUEUE_NAME.maintenance,
      redisUrl: url,
      drainTimeoutMs: 2_000,
      redisTelemetry: {
        connectionEvent: ({ event }) => {
          if (event === 'error') connectionErrors.count += 1;
        },
        operationFinished: () => undefined,
      },
    });
    return consumer;
  };

  beforeAll(async () => {
    cleaner = new Redis(direct.toString(), { maxRetriesPerRequest: 1 });
    await cleaner.flushdb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await consumer?.close();
    consumer = undefined;
    await cleaner.flushdb();
  });

  afterAll(async () => {
    await cleaner.quit();
  });

  it('has not stopped while it is open and fetching', async () => {
    const opened = open(direct.toString());
    await opened.waitUntilReady();

    expect(opened.isReady()).toBe(true);
    expect(opened.hasStopped()).toBe(false);
  });

  // An outage is no reason to restart anything: BullMQ picks up where it left off,
  // and the health check would otherwise end a worker Redis had let down.
  it('has not stopped through repeated Redis outages and recovers readiness with delivery', async () => {
    const redis = await createCuttableRedis(direct);
    let deliveries = 0;
    const connectionErrors = { count: 0 };
    const opened = open(
      redis.url,
      () => {
        deliveries += 1;
        return Promise.resolve();
      },
      connectionErrors,
    );
    try {
      await opened.waitUntilReady();
      expect(opened.isReady()).toBe(true);
      await redis.cut();
      await vi.waitFor(
        () => {
          expect(connectionErrors.count).toBeGreaterThanOrEqual(3);
          expect(opened.isReady()).toBe(false);
        },
        { timeout: 30_000, interval: 20 },
      );
      expect(opened.hasStopped()).toBe(false);
      await redis.restore();
      const producer = createQueueProducer({ redisUrl: direct.toString() });
      try {
        await producer.waitUntilReady();
        await producer.publish({
          name: JOB_NAME.deliverWorkspaceInvitation,
          data: {
            workspaceId: randomUUID(),
            invitationId: randomUUID(),
            deliveryAttemptId: randomUUID(),
            outboxEventId: randomUUID(),
          },
        });
        await vi.waitFor(
          () => {
            expect(deliveries).toBe(1);
          },
          { timeout: 30_000 },
        );
      } finally {
        await producer.close();
      }
      await vi.waitFor(() => {
        expect(opened.isReady()).toBe(true);
      });
      expect(opened.hasStopped()).toBe(false);
      const previousErrors = connectionErrors.count;
      await redis.cut();
      await vi.waitFor(
        () => {
          expect(connectionErrors.count).toBeGreaterThan(previousErrors);
          expect(opened.isReady()).toBe(false);
        },
        { timeout: 30_000 },
      );
      expect(opened.hasStopped()).toBe(false);
      await redis.restore();
      await vi.waitFor(
        () => {
          expect(opened.isReady()).toBe(true);
        },
        {
          timeout: 30_000,
        },
      );
      await opened.close();
      expect(opened.isReady()).toBe(false);
      expect(opened.hasStopped()).toBe(false);
    } finally {
      try {
        await opened.close();
      } finally {
        await redis.cut();
      }
    }
  }, 60_000);

  it('has not stopped once it has been closed', async () => {
    const opened = open(direct.toString());
    await opened.waitUntilReady();

    await opened.close();

    expect(opened.isReady()).toBe(false);
    expect(opened.hasStopped()).toBe(false);
  });

  // Nothing public ends BullMQ's loop while the worker stays open, which is why the
  // health check has to look. This fails the loop itself: the process, the consumer
  // and Redis all carry on.
  it('has stopped when the fetch loop ends while it is open', async () => {
    const loopDied = Promise.withResolvers<never>();
    const prototype = Worker.prototype as unknown as {
      mainLoop: (this: unknown) => Promise<void>;
    };
    const mainLoop = prototype.mainLoop;
    vi.spyOn(prototype, 'mainLoop').mockImplementation(function (
      this: unknown,
    ) {
      return Promise.race([mainLoop.call(this), loopDied.promise]);
    });
    const opened = open(direct.toString());
    await opened.waitUntilReady();
    expect(opened.hasStopped()).toBe(false);

    loopDied.reject(new Error('fetch loop ended'));

    await vi.waitFor(() => {
      expect(opened.hasStopped()).toBe(true);
    });
    expect(opened.isReady()).toBe(false);

    await opened.close();
    expect(opened.hasStopped()).toBe(false);
  });
});
