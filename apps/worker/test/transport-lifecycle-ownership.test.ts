import type { OutboxDispatcherDatabase } from '@pertexo/database/testing';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import {
  JOB_NAME,
  type QueueConsumer,
  type QueueProducer,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../src/config/worker-config.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import {
  createOwnedOutboxDispatcher,
  type DispatcherCompositionFactories,
} from '../src/transport/dispatch-providers.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { OutboxDispatcherLifecycle } from '../src/transport/transport-lifecycle.js';

function config() {
  return parseWorkerConfig({
    DATABASE_DISPATCHER_URL:
      'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
    DATABASE_WORKER_URL:
      'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
    REDIS_URL: 'redis://localhost:6379/0',
    OUTBOX_DISPATCH_JOB_NAMES: JOB_NAME.advanceWorkflowRun,
  });
}

function database(close: () => Promise<void> | void): OutboxDispatcherDatabase {
  return {
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    claimBatch: vi.fn().mockResolvedValue({ events: [], exhaustedCount: 0 }),
    close,
    markPublished: vi.fn().mockResolvedValue(true),
    observeBacklog: vi.fn().mockResolvedValue({ backlog: 0 }),
    releaseOrFail: vi.fn().mockResolvedValue('retry_scheduled'),
  } as unknown as OutboxDispatcherDatabase;
}

function producer(close: () => Promise<void> | void): QueueProducer {
  return {
    close,
    isReady: () => true,
    observe: () => Promise.resolve([]),
    publish: () => Promise.reject(new Error('not exercised')),
    waitUntilReady: () => Promise.resolve(),
  } as unknown as QueueProducer;
}

const metrics = {
  addActiveConcurrency: vi.fn(),
  observeArtifacts: vi.fn(),
  observeExecutionStorage: vi.fn(),
  observeOutbox: vi.fn(),
  observeQueue: vi.fn(),
  recordConsumerLifecycle: vi.fn(),
  recordHandlerFinished: vi.fn(),
  recordOutboxClaim: vi.fn(),
  recordOutboxDispatchLatency: vi.fn(),
  recordOutboxLeaseEvent: vi.fn(),
  recordOutboxPublish: vi.fn(),
  recordQueueStall: vi.fn(),
  recordWorkerProcessStart: vi.fn(),
} satisfies TransportMetrics;

const consumer: QueueConsumer = {
  close: () => Promise.resolve({ abortedJobs: 0, forced: false }),
  isReady: () => true,
  waitUntilReady: () => Promise.resolve(),
};

const capabilities = createDispatchConsumerCapabilityRegistry([
  { jobName: JOB_NAME.advanceWorkflowRun, consumer },
]);

describe('transport composition ownership', () => {
  it('does not acquire later dispatcher resources when database construction fails', async () => {
    const constructionFailure = new Error('database construction failed');
    const producerFactory = vi.fn();
    const dispatcherFactory = vi.fn();
    const factories = {
      database: vi.fn(() => {
        throw constructionFailure;
      }),
      producer: producerFactory,
      dispatcher: dispatcherFactory,
    } as unknown as DispatcherCompositionFactories;

    await expect(
      createOwnedOutboxDispatcher(
        config(),
        {},
        new WorkerDrainState(),
        metrics,
        capabilities,
        factories,
      ),
    ).rejects.toBe(constructionFailure);
    expect(producerFactory).not.toHaveBeenCalled();
    expect(dispatcherFactory).not.toHaveBeenCalled();
  });

  it('closes an acquired dispatcher database when producer construction fails', async () => {
    const constructionFailure = new Error('producer construction failed');
    const close = vi.fn();
    const factories = {
      database: vi.fn(() => database(close)),
      producer: vi.fn(() => {
        throw constructionFailure;
      }),
      dispatcher: vi.fn(),
    } as unknown as DispatcherCompositionFactories;

    await expect(
      createOwnedOutboxDispatcher(
        config(),
        {},
        new WorkerDrainState(),
        metrics,
        capabilities,
        factories,
      ),
    ).rejects.toBe(constructionFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves constructor and every acquired cleanup failure', async () => {
    const constructionFailure = new Error('dispatcher construction failed');
    const databaseFailure = new Error('database cleanup failed');
    const producerFailure = new Error('producer cleanup failed');
    const databaseClose = vi.fn(() => {
      throw databaseFailure;
    });
    const producerClose = vi.fn(() => Promise.reject(producerFailure));
    const factories = {
      database: vi.fn(() => database(databaseClose)),
      producer: vi.fn(() => producer(producerClose)),
      dispatcher: vi.fn(() => {
        throw constructionFailure;
      }),
    } as unknown as DispatcherCompositionFactories;

    const failure = await createOwnedOutboxDispatcher(
      config(),
      {},
      new WorkerDrainState(),
      metrics,
      capabilities,
      factories,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      databaseFailure,
      producerFailure,
    ]);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(producerClose).toHaveBeenCalledOnce();
  });

  it('transfers successful dispatcher boundary ownership exactly once', async () => {
    const databaseClose = vi.fn();
    const producerClose = vi.fn();
    const selectedDatabase = database(databaseClose);
    const selectedProducer = producer(producerClose);
    const factories = {
      database: vi.fn(() => selectedDatabase),
      producer: vi.fn(() => selectedProducer),
      dispatcher: (
        selectedDb,
        selectedQueue,
        drain,
        options,
        selectedMetrics,
        selectedCapabilities,
      ) =>
        new OutboxDispatcher(
          selectedDb,
          selectedQueue,
          drain,
          options,
          selectedMetrics,
          selectedCapabilities,
        ),
    } as DispatcherCompositionFactories;
    const dispatcher = await createOwnedOutboxDispatcher(
      config(),
      {},
      new WorkerDrainState(),
      metrics,
      capabilities,
      factories,
    );

    const first = dispatcher.close();
    const second = dispatcher.close();
    expect(second).toBe(first);
    await first;
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(producerClose).toHaveBeenCalledOnce();
  });
});

function runtime(close: () => Promise<void> | void) {
  return {
    consumer,
    checkReadiness: () => Promise.resolve(),
    whenIdle: () => Promise.resolve(),
    close: () => Promise.resolve().then(close),
  };
}

describe('transport Nest lifecycle ownership', () => {
  it('drains first, closes dispatcher before runtimes, aggregates failures, and caches settlement', async () => {
    const order: string[] = [];
    const dispatcherFailure = new Error('dispatcher close failed');
    const coordinatorFailure = new Error('coordinator close failed');
    const nodeFailure = new Error('node close failed');
    const triggerFailure = new Error('trigger close failed');
    const dispatcherClose = vi.fn(() => {
      order.push('dispatcher');
      throw dispatcherFailure;
    });
    const coordinatorClose = vi.fn(() => {
      order.push('coordinator');
      return Promise.reject(coordinatorFailure);
    });
    const nodeClose = vi.fn(() => {
      order.push('node');
      throw nodeFailure;
    });
    const previewClose = vi.fn(() => {
      order.push('preview');
    });
    const triggerClose = vi.fn(() => {
      order.push('trigger');
      return Promise.reject(triggerFailure);
    });
    const drain = new WorkerDrainState();
    const lifecycle = new OutboxDispatcherLifecycle(
      { close: dispatcherClose } as unknown as OutboxDispatcher,
      runtime(coordinatorClose),
      runtime(nodeClose),
      runtime(previewClose),
      runtime(triggerClose),
      drain,
    );

    lifecycle.beginDrain();
    expect(drain.canAcceptWork()).toBe(false);
    const first = lifecycle.close();
    const second = lifecycle.close();
    expect(second).toBe(first);
    const failure = await first.catch((error: unknown) => error);

    expect(order[0]).toBe('dispatcher');
    expect(order.slice(1).sort()).toEqual(
      ['coordinator', 'node', 'preview', 'trigger'].sort(),
    );
    expect((failure as AggregateError).errors).toEqual([
      dispatcherFailure,
      coordinatorFailure,
      nodeFailure,
      triggerFailure,
    ]);
    for (const close of [
      dispatcherClose,
      coordinatorClose,
      nodeClose,
      previewClose,
      triggerClose,
    ])
      expect(close).toHaveBeenCalledOnce();
  });
});
