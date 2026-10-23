import { vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface QueueInstance {
    name: string;
    options: unknown;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getJobCountByTypes: ReturnType<typeof vi.fn>;
    getJobs: ReturnType<typeof vi.fn>;
    waitUntilReady: ReturnType<typeof vi.fn>;
  }

  interface RedisClient {
    status: string;
    on: (event: string, listener: () => void) => RedisClient;
    emit: (event: string) => boolean;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }

  const queueInstances: QueueInstance[] = [];
  const redisClients: RedisClient[] = [];
  const redisFactoryState = { nextStatus: 'ready' };

  const createRedisClient = (): RedisClient => {
    const listeners = new Map<string, (() => void)[]>();
    const client: RedisClient = {
      status: redisFactoryState.nextStatus,
      on: vi.fn((event: string, listener: () => void) => {
        const eventListeners = listeners.get(event) ?? [];
        eventListeners.push(listener);
        listeners.set(event, eventListeners);
        return client;
      }),
      emit: vi.fn((event: string) => {
        for (const listener of listeners.get(event) ?? []) listener();
        return true;
      }),
      quit: vi.fn(() => Promise.resolve('OK')),
      disconnect: vi.fn((): unknown => undefined),
    };
    redisClients.push(client);
    return client;
  };

  const Queue = vi.fn(function QueueMock(name: string, options: unknown) {
    const queue: QueueInstance = {
      name,
      options,
      add: vi.fn(() => Promise.resolve({ id: 'mock-job-id' })),
      close: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      getJobCountByTypes: vi.fn(() => Promise.resolve(0)),
      getJobs: vi.fn(() => Promise.resolve([])),
      waitUntilReady: vi.fn(() => Promise.resolve()),
    };
    queueInstances.push(queue);
    return queue;
  });
  const Redis = vi.fn(function RedisMock() {
    return createRedisClient();
  });

  return { Queue, Redis, queueInstances, redisClients, redisFactoryState };
});

vi.mock('bullmq', () => ({ Queue: mocks.Queue }));

vi.mock('ioredis', () => ({ Redis: mocks.Redis, default: mocks.Redis }));

export const IDS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  outboxEventId: '88888888-8888-4888-8888-888888888888',
} as const;

export function redisClient(index = mocks.redisClients.length - 1) {
  const client = mocks.redisClients[index];
  if (client === undefined) throw new Error('Expected Redis test client');
  return client;
}

export function resetPackagesQueueTestProducerTestTsBullMQQueueProducerFixture() {
  vi.clearAllMocks();
  mocks.queueInstances.length = 0;
  mocks.redisClients.length = 0;
  mocks.redisFactoryState.nextStatus = 'ready';
}

export { mocks };
