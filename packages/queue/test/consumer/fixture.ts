import { vi } from 'vitest';

import { JOB_NAME } from '../../src/jobs/names.js';

const mocks = vi.hoisted(() => {
  type Processor = (
    job: { id?: string; name: string; data: unknown; attemptsMade: number },
    token?: string,
    signal?: AbortSignal,
  ) => Promise<void>;

  interface WorkerInstance {
    name: string;
    options: Record<string, unknown>;
    processor: Processor;
    running: boolean;
    paused: boolean;
    waitUntilReady: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    cancelAllJobs: ReturnType<typeof vi.fn>;
    isRunning: () => boolean;
    isPaused: () => boolean;
    on: ReturnType<typeof vi.fn>;
  }

  const workerInstances: WorkerInstance[] = [];
  const workerListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const redisClient = {
    status: 'ready',
    on: vi.fn(() => redisClient),
    quit: vi.fn(() => Promise.resolve('OK')),
    disconnect: vi.fn(),
  };

  class UnrecoverableError extends Error {
    public override readonly name = 'UnrecoverableError';
  }

  const Worker = vi.fn(function WorkerMock(
    name: string,
    processor: Processor,
    options: Record<string, unknown>,
  ) {
    const instance: WorkerInstance = {
      name,
      options,
      processor,
      running: true,
      paused: false,
      waitUntilReady: vi.fn(() => Promise.resolve()),
      pause: vi.fn((doNotWaitActive: boolean) => {
        instance.paused = true;
        return Promise.resolve(doNotWaitActive);
      }),
      close: vi.fn(() => {
        instance.running = false;
        return Promise.resolve();
      }),
      disconnect: vi.fn(() => Promise.resolve()),
      cancelAllJobs: vi.fn(),
      isRunning: () => instance.running,
      isPaused: () => instance.paused,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const listeners = workerListeners.get(event) ?? [];
        listeners.push(listener);
        workerListeners.set(event, listeners);
        return instance;
      }),
    };
    workerInstances.push(instance);
    return instance;
  });

  const Redis = vi.fn(function RedisMock() {
    return redisClient;
  });

  return {
    Redis,
    UnrecoverableError,
    Worker,
    redisClient,
    workerInstances,
    workerListeners,
  };
});

vi.mock('bullmq', () => ({
  UnrecoverableError: mocks.UnrecoverableError,
  Worker: mocks.Worker,
}));

vi.mock('ioredis', () => ({ Redis: mocks.Redis, default: mocks.Redis }));

export const IDS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  outboxEventId: '88888888-8888-4888-8888-888888888888',
  nodeRunId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
} as const;

export const validJob = {
  id: `outbox-${IDS.outboxEventId}`,
  name: JOB_NAME.advanceWorkflowRun,
  data: {
    workspaceId: IDS.workspaceId,
    runId: IDS.runId,
    outboxEventId: IDS.outboxEventId,
  },
  attemptsMade: 1,
};

export const TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

export function resetPackagesQueueTestConsumerTestTsBullMQQueueConsumerFixture() {
  vi.clearAllMocks();
  mocks.workerInstances.length = 0;
  mocks.workerListeners.clear();
  mocks.redisClient.status = 'ready';
  mocks.redisClient.quit.mockReset().mockResolvedValue('OK');
  mocks.redisClient.disconnect.mockReset().mockImplementation(() => undefined);
}

export { mocks };
