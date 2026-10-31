import type { Queue } from 'bullmq';

import type { QueueJob } from '../jobs/contracts.js';
import type { JobName, QueueName } from '../jobs/names.js';
import type { RedisTelemetryObserver } from '../redis/telemetry-contracts.js';

export type QueueProducerOptions = Readonly<{
  readonly redisUrl: string;
  readonly readyTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly redisTelemetry?: RedisTelemetryObserver;
}>;

export type EnqueuedQueueJob = Readonly<{
  readonly jobId: string;
  readonly jobName: JobName;
  readonly queueName: QueueName;
}>;

export type QueuePublishResult = EnqueuedQueueJob &
  (
    | Readonly<{ readonly outcome: 'published' }>
    | Readonly<{
        readonly outcome: 'outcome_unknown';
        /** Never rejects; records how the already-started publication settles. */
        readonly settlement: Promise<'failed' | 'published'>;
      }>
  );

export interface QueueStateObservation {
  readonly depth: number;
  /** Age of the oldest waiting job, excluding delayed work; zero when empty. */
  readonly oldestJobAgeSeconds: number;
  readonly queueName: QueueName;
}

export interface QueueProducer {
  /** Returns within the configured deadline without misclassifying a timeout as failure. */
  publish(job: QueueJob, redeliveries?: number): Promise<QueuePublishResult>;
  observe(): Promise<readonly QueueStateObservation[]>;
  isReady(): boolean;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export type QueueMap = Readonly<Record<QueueName, Queue>>;
