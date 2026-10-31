import type { QueueJob } from '../jobs/contracts.js';

import type { QueueName } from '../jobs/names.js';
import type { RedisTelemetryObserver } from '../redis/telemetry-contracts.js';

export interface QueueDeliveryTransport {
  readonly attemptsMade: number;
  readonly jobId: string;
}

export type QueueDelivery = QueueJob & {
  readonly transport: QueueDeliveryTransport;
};

export interface QueueHandlerContext {
  /**
   * Aborts when BullMQ cancels the job, the queue-class execution timeout
   * expires, or bounded worker drain expires. Handlers must propagate it to
   * cancellable I/O and may not treat an abort as business completion.
   */
  readonly signal: AbortSignal;
}

export type QueueJobHandler = (
  delivery: QueueDelivery,
  context: QueueHandlerContext,
) => Promise<void>;

export type QueueHandlerFailureClass =
  'drain' | 'handler' | 'timeout' | 'transport';

export interface QueueHandlerObservation {
  readonly jobName: QueueJob['name'];
  readonly queueName: QueueName;
}

/** Activation seam implemented by the observability package with OpenTelemetry. */
export interface QueueTraceRunner {
  run<T>(
    traceparent: string | undefined,
    observation: QueueHandlerObservation,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export type QueueHandlerFinishedObservation = QueueHandlerObservation &
  (
    | {
        readonly durationSeconds: number;
        readonly outcome: 'completed';
      }
    | {
        readonly durationSeconds: number;
        readonly failureClass: QueueHandlerFailureClass;
        readonly outcome: 'failed';
      }
  );

/** One failed delivery, with what an operator needs to find the run it stopped. */
export interface QueueDeliveryFailure extends QueueHandlerObservation {
  readonly attemptsMade: number;
  readonly error: unknown;
  readonly failureClass: QueueHandlerFailureClass;
  readonly outboxEventId: string;
  readonly runId?: string;
  readonly workspaceId: string;
}

export interface QueueConsumerLifecycleObservation {
  readonly event: 'drain_forced' | 'drain_graceful' | 'ready';
  readonly queueName: QueueName;
}

export interface QueueStallObservation {
  readonly queueName: QueueName;
}

/**
 * Dependency-free lifecycle seam for bounded operational instrumentation.
 * Metrics stay free of identifiers; only a failed delivery carries them, for the log.
 */
export interface QueueConsumerObserver {
  consumerLifecycle?(observation: QueueConsumerLifecycleObservation): void;
  deliveryFailed?(failure: QueueDeliveryFailure): void;
  handlerFinished(observation: QueueHandlerFinishedObservation): void;
  handlerStarted(observation: QueueHandlerObservation): void;
  jobStalled?(observation: QueueStallObservation): void;
}

export type QueueConsumerOptions = Readonly<{
  readonly queueName: QueueName;
  readonly redisUrl: string;
  readonly handler: QueueJobHandler;
  readonly observer?: QueueConsumerObserver;
  readonly redisTelemetry?: RedisTelemetryObserver;
  readonly traceRunner?: QueueTraceRunner;
  readonly readyTimeoutMs?: number;
  /** Test/deployment override; defaults to the selected queue class. */
  readonly timeoutMs?: number;
  /** Test/deployment override; defaults to the selected queue class. */
  readonly drainTimeoutMs?: number;
}>;

export interface QueueConsumerCloseResult {
  readonly abortedJobs: number;
  readonly forced: boolean;
}

export interface QueueConsumer {
  close(): Promise<QueueConsumerCloseResult>;
  isReady(): boolean;
  waitUntilReady(timeoutMs?: number): Promise<void>;
}

export interface ParsedConsumerOptions {
  readonly drainTimeoutMs: number;
  readonly handler: QueueJobHandler;
  readonly observer: QueueConsumerObserver | undefined;
  readonly traceRunner: QueueTraceRunner | undefined;
  readonly queueName: QueueName;
  readonly readyTimeoutMs: number;
  readonly redisUrl: string;
  readonly redisTelemetry: RedisTelemetryObserver | undefined;
  readonly timeoutMs: number;
}

export interface ActiveExecution {
  abortFailureClass: QueueHandlerFailureClass | undefined;
  readonly controller: AbortController;
}
