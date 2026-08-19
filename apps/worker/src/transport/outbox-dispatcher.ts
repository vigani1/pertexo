import { randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database';
import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/database';
import {
  createTransportMetrics,
  type TransportErrorClass,
  type TransportJob,
  type TransportMetrics,
} from '@pertexo/observability/transport-metrics';
import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QueueNotReadyError,
  QueuePublishTimeoutError,
  parseQueueJob,
  type QueueJob,
  type QueueProducer,
} from '@pertexo/queue';
import { z } from 'zod';

import type { WorkerDrainState } from '../runtime/worker-drain-state.js';

const optionsSchema = z
  .object({
    batchSize: z.number().int().min(1).max(100),
    leaseDurationMillis: z.number().int().min(1_000).max(300_000),
    leaseOwner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    maxAttempts: z.number().int().min(1).max(1_000),
    operationTimeoutMillis: z
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(5_000),
    pollIntervalMillis: z.number().int().min(10).max(60_000).default(250),
    retryDelayMillis: z.number().int().min(1).max(300_000),
  })
  .strict();

export type OutboxDispatcherOptions = Readonly<z.input<typeof optionsSchema>>;

export type OutboxDispatchResult = Readonly<{
  claimed: number;
  failed: number;
  published: number;
  stale: number;
}>;

export class OutboxPayloadChecksumError extends Error {
  public constructor(eventId: string) {
    super(`Outbox event ${eventId} has an invalid payload checksum`);
    this.name = 'OutboxPayloadChecksumError';
  }
}

export class OutboxContractError extends Error {
  public constructor(eventId: string, cause: unknown) {
    super(`Outbox event ${eventId} does not match a queue contract`, { cause });
    this.name = 'OutboxContractError';
  }
}

export class OutboxDispatcherClosedError extends Error {
  public constructor() {
    super('Outbox dispatcher is closed');
    this.name = 'OutboxDispatcherClosedError';
  }
}

class TransportOperationTimeoutError extends Error {
  public override readonly name = 'TransportOperationTimeoutError';

  public constructor(timeoutMillis: number) {
    super(`Transport operation exceeded ${String(timeoutMillis)}ms`);
  }
}

const transportJobByName = Object.freeze({
  [JOB_NAME.advanceWorkflowRun]: {
    jobName: JOB_NAME.advanceWorkflowRun,
    queueName: QUEUE_FOR_JOB[JOB_NAME.advanceWorkflowRun],
  },
  [JOB_NAME.executeNodeAttempt]: {
    jobName: JOB_NAME.executeNodeAttempt,
    queueName: QUEUE_FOR_JOB[JOB_NAME.executeNodeAttempt],
  },
  [JOB_NAME.reconcileWorkflowTriggers]: {
    jobName: JOB_NAME.reconcileWorkflowTriggers,
    queueName: QUEUE_FOR_JOB[JOB_NAME.reconcileWorkflowTriggers],
  },
  [JOB_NAME.expireArtifacts]: {
    jobName: JOB_NAME.expireArtifacts,
    queueName: QUEUE_FOR_JOB[JOB_NAME.expireArtifacts],
  },
} as const satisfies Record<QueueJob['name'], TransportJob>);

const transportJobNameSchema = z.enum(JOB_NAME);

function transportJob(job: QueueJob): TransportJob {
  return transportJobByName[job.name];
}

function transportJobName(jobName: string): TransportJob | undefined {
  const parsed = transportJobNameSchema.safeParse(jobName);
  return parsed.success ? transportJobByName[parsed.data] : undefined;
}

function transportErrorClass(error: unknown): TransportErrorClass {
  if (
    error instanceof OutboxPayloadChecksumError ||
    error instanceof OutboxContractError
  ) {
    return 'contract';
  }
  if (
    error instanceof QueuePublishTimeoutError ||
    error instanceof TransportOperationTimeoutError
  ) {
    return 'timeout';
  }
  if (error instanceof QueueNotReadyError) {
    return 'unavailable';
  }
  return 'redis';
}

function toQueueJob(event: LeasedOutboxEvent): QueueJob {
  if (canonicalOutboxPayloadChecksum(event.payload) !== event.payloadChecksum) {
    throw new OutboxPayloadChecksumError(event.id);
  }
  if (
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new OutboxContractError(
      event.id,
      new TypeError('Payload is not an object'),
    );
  }

  try {
    return parseQueueJob({
      name: event.jobName,
      data: {
        ...event.payload,
        outboxEventId: event.id,
        schemaVersion: event.schemaVersion,
        workspaceId: event.workspaceId,
      },
    });
  } catch (error: unknown) {
    throw new OutboxContractError(event.id, error);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof OutboxPayloadChecksumError) {
    return 'outbox.checksum_mismatch';
  }
  if (error instanceof OutboxContractError) {
    return 'outbox.invalid_contract';
  }
  return 'queue.publish_failed';
}

const EMPTY_RESULT: OutboxDispatchResult = Object.freeze({
  claimed: 0,
  failed: 0,
  published: 0,
  stale: 0,
});

function bounded<T>(promise: Promise<T>, timeoutMillis: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TransportOperationTimeoutError(timeoutMillis));
    }, timeoutMillis);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error('Transport operation failed', { cause: error }),
        );
      },
    );
  });
}

export class OutboxDispatcher {
  private readonly options: z.output<typeof optionsSchema>;
  private lifecycle: 'idle' | 'running' | 'closed' = 'idle';
  private loopPromise: Promise<void> | undefined;
  private wakeLoop: (() => void) | undefined;

  public constructor(
    private readonly database: OutboxDispatcherDatabase,
    private readonly producer: QueueProducer,
    private readonly drainState: WorkerDrainState,
    options: OutboxDispatcherOptions,
    private readonly metrics: TransportMetrics = createTransportMetrics(),
  ) {
    this.options = Object.freeze(optionsSchema.parse(options));
  }

  public start(): void {
    this.assertOpen();
    if (this.lifecycle === 'running') return;
    this.lifecycle = 'running';
    this.loopPromise = this.runLoop();
  }

  public async dispatchOnce(): Promise<OutboxDispatchResult> {
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) return EMPTY_RESULT;

    const claim = await this.database.claimBatch({
      leaseDurationMillis: this.options.leaseDurationMillis,
      leaseOwner: this.options.leaseOwner,
      leaseToken: randomUUID(),
      limit: this.options.batchSize,
      maxAttempts: this.options.maxAttempts,
    });
    const { events } = claim;
    this.observeMetrics(() => {
      this.metrics.recordOutboxClaim({ batchSize: events.length });
      if (claim.exhaustedCount > 0) {
        this.metrics.recordOutboxLeaseEvent(
          'attempt_exhausted',
          claim.exhaustedCount,
        );
      }
      for (const event of events) {
        if (event.publishAttempts > 1) {
          this.metrics.recordOutboxLeaseEvent('reclaimed');
        }
      }
    });
    const outcomes = await Promise.all(
      events.map((event) => this.dispatch(event)),
    );
    await Promise.all([this.observeOutbox(), this.observeQueues()]);

    return Object.freeze({
      claimed: events.length,
      failed: outcomes.filter((outcome) => outcome === 'failed').length,
      published: outcomes.filter((outcome) => outcome === 'published').length,
      stale: outcomes.filter((outcome) => outcome === 'stale').length,
    });
  }

  public async checkReadiness(): Promise<void> {
    this.assertOpen();
    if (!this.drainState.canAcceptWork()) {
      throw new Error('Outbox dispatcher is draining');
    }
    await Promise.all([
      this.database.checkReadiness(),
      this.producer.waitUntilReady(),
    ]);
  }

  public async close(): Promise<void> {
    if (this.lifecycle === 'closed') return;
    this.lifecycle = 'closed';
    this.wakeLoop?.();
    const loopResults = await Promise.allSettled([
      this.loopPromise === undefined
        ? Promise.resolve()
        : bounded(this.loopPromise, this.options.operationTimeoutMillis),
    ]);
    const closeResults = await Promise.allSettled([
      bounded(this.database.close(), this.options.operationTimeoutMillis),
      bounded(this.producer.close(), this.options.operationTimeoutMillis),
    ]);
    const results = [...loopResults, ...closeResults];
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejection !== undefined) throw rejection.reason;
  }

  private async dispatch(
    event: LeasedOutboxEvent,
  ): Promise<'failed' | 'published' | 'stale'> {
    let jobObservation: TransportJob | undefined;
    let queuePublished = false;
    try {
      jobObservation = transportJobName(event.jobName);
      const job = toQueueJob(event);
      const currentJob = transportJob(job);
      jobObservation = currentJob;
      await bounded(
        this.producer.publish(job),
        this.options.operationTimeoutMillis,
      );
      queuePublished = true;
      this.observeMetrics(() => {
        this.metrics.recordOutboxPublish({
          ...currentJob,
          outcome: 'published',
        });
      });
      const marked = await bounded(
        this.database.markPublished(event.id, event.leaseToken),
        this.options.operationTimeoutMillis,
      );
      this.observeMetrics(() => {
        this.metrics.recordOutboxDispatchLatency({
          ...currentJob,
          durationSeconds: Math.max(
            0,
            (Date.now() - event.availableAt.getTime()) / 1_000,
          ),
          outcome: marked ? 'published' : 'stale',
        });
      });
      if (!marked) {
        this.observeMetrics(() => {
          this.metrics.recordOutboxLeaseEvent('expired');
        });
      }
      return marked ? 'published' : 'stale';
    } catch (error: unknown) {
      if (jobObservation !== undefined && !queuePublished) {
        const failedJob = jobObservation;
        this.observeMetrics(() => {
          this.metrics.recordOutboxPublish({
            ...failedJob,
            errorClass: transportErrorClass(error),
            outcome: 'failed',
          });
        });
      }
      const releaseResult = await bounded(
        this.database.releaseOrFail({
          errorCode: errorCode(error),
          id: event.id,
          leaseToken: event.leaseToken,
          maxAttempts: this.options.maxAttempts,
          retryAt: new Date(Date.now() + this.options.retryDelayMillis),
        }),
        this.options.operationTimeoutMillis,
      );
      if (releaseResult === 'failed') {
        this.observeMetrics(() => {
          this.metrics.recordOutboxLeaseEvent('attempt_exhausted');
        });
      } else if (releaseResult === 'not_leased') {
        this.observeMetrics(() => {
          this.metrics.recordOutboxLeaseEvent('expired');
        });
      }
      return 'failed';
    }
  }

  private async runLoop(): Promise<void> {
    while (this.lifecycle === 'running' && this.drainState.canAcceptWork()) {
      try {
        await this.dispatchOnce();
      } catch {
        // Readiness surfaces boundary health. The loop stays alive so a
        // transient PostgreSQL/Redis failure cannot permanently stop dispatch.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollIntervalMillis);
        this.wakeLoop = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeLoop = undefined;
    }
  }

  private assertOpen(): void {
    if (this.lifecycle === 'closed') throw new OutboxDispatcherClosedError();
  }

  private observeMetrics(observe: () => void): void {
    try {
      observe();
    } catch {
      // Operational telemetry cannot alter durable dispatch behavior.
    }
  }

  private async observeQueues(): Promise<void> {
    try {
      const observations = await bounded(
        this.producer.observe(),
        this.options.operationTimeoutMillis,
      );
      this.observeMetrics(() => {
        for (const observation of observations) {
          this.metrics.observeQueue(observation);
        }
      });
    } catch {
      // Queue-state telemetry is best-effort and cannot fail dispatch.
    }
  }

  private async observeOutbox(): Promise<void> {
    try {
      const observation = await bounded(
        this.database.observeBacklog(),
        this.options.operationTimeoutMillis,
      );
      this.observeMetrics(() => {
        this.metrics.observeOutbox(observation);
      });
    } catch {
      // Backlog telemetry is best-effort and cannot fail dispatch.
    }
  }
}
