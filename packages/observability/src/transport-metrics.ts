import { metrics, type Attributes, type Meter } from '@opentelemetry/api';

import './server-only.js';

export const TRANSPORT_METRIC_NAME = Object.freeze({
  artifactBytes: 'pertexo.transport.artifact.bytes',
  artifactCount: 'pertexo.transport.artifact.count',
  activeConcurrency: 'pertexo.transport.handler.active',
  consumerLifecycle: 'pertexo.transport.consumer.lifecycle',
  handlerDuration: 'pertexo.transport.handler.duration',
  handlerExecutions: 'pertexo.transport.handler.executions',
  outboxBacklog: 'pertexo.transport.outbox.backlog',
  outboxClaimBatchSize: 'pertexo.transport.outbox.claim.batch_size',
  outboxClaimed: 'pertexo.transport.outbox.claimed',
  outboxDispatchLatency: 'pertexo.transport.outbox.dispatch_latency',
  outboxLeaseEvents: 'pertexo.transport.outbox.lease.events',
  outboxOldestAge: 'pertexo.transport.outbox.oldest_age',
  outboxPublish: 'pertexo.transport.outbox.publish',
  queueDepth: 'pertexo.transport.queue.depth',
  queueOldestJobAge: 'pertexo.transport.queue.oldest_job_age',
  queueStalls: 'pertexo.transport.queue.stalls',
  workerProcessStarts: 'pertexo.worker.process.starts',
} as const);

export type TransportErrorClass =
  'contract' | 'database' | 'redis' | 'timeout' | 'unavailable' | 'unknown';

export type TransportLeaseEvent = 'attempt_exhausted' | 'expired' | 'reclaimed';

export type TransportJob =
  | {
      readonly jobName: 'advance-workflow-run';
      readonly queueName: 'workflow-coordinator';
    }
  | {
      readonly jobName: 'execute-node-attempt';
      readonly queueName: 'node-attempts';
    }
  | {
      readonly jobName: 'execute-preview-attempt';
      readonly queueName: 'node-attempts';
    }
  | {
      readonly jobName: 'reconcile-preview-attempt';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'expire-artifacts';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'sweep-expired-previews';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'reconcile-workflow-triggers';
      readonly queueName: 'trigger-lifecycle';
    };

export type TransportPublishMeasurement = TransportJob &
  (
    | { readonly outcome: 'deduplicated' | 'published' }
    | {
        readonly errorClass: TransportErrorClass;
        readonly outcome: 'failed';
      }
  );

export type TransportHandlerMeasurement = TransportJob &
  (
    | {
        readonly durationSeconds: number;
        readonly outcome: 'completed';
      }
    | {
        readonly durationSeconds: number;
        readonly errorClass: TransportErrorClass;
        readonly outcome: 'failed';
      }
  );

export interface OutboxClaimMeasurement {
  /** Number of rows acquired by this bounded claim operation. */
  readonly batchSize: number;
}

export interface OutboxObservation {
  /** Number of currently publishable, unclaimed outbox rows. */
  readonly backlog: number;
  /** Age of the oldest currently publishable row, or zero for an empty backlog. Omit when unknown. */
  readonly oldestAgeSeconds?: number;
}

export interface QueueObservation {
  readonly depth: number;
  /** Age of the oldest waiting job, or zero for an empty queue. */
  readonly oldestJobAgeSeconds: number;
  readonly queueName: TransportJob['queueName'];
}

export interface ArtifactObservation {
  readonly bytes: number;
  readonly count: number;
  readonly status: 'available' | 'deleted' | 'deleting' | 'pending';
}

export interface ConsumerLifecycleMeasurement {
  readonly event: 'drain_forced' | 'drain_graceful' | 'ready';
  readonly queueName: TransportJob['queueName'];
}

export type OutboxDispatchLatencyMeasurement = TransportJob & {
  readonly durationSeconds: number;
  readonly outcome: 'published' | 'stale';
};

export type ActiveConcurrencyChange = TransportJob & {
  /** Use 1 when a handler starts and -1 when it stops. */
  readonly delta: -1 | 1;
};

export interface TransportMetrics {
  addActiveConcurrency(change: ActiveConcurrencyChange): void;
  observeArtifacts(observation: ArtifactObservation): void;
  observeOutbox(observation: OutboxObservation): void;
  observeQueue(observation: QueueObservation): void;
  recordHandlerFinished(measurement: TransportHandlerMeasurement): void;
  recordConsumerLifecycle(measurement: ConsumerLifecycleMeasurement): void;
  recordOutboxClaim(measurement: OutboxClaimMeasurement): void;
  recordOutboxLeaseEvent(event: TransportLeaseEvent, count?: number): void;
  recordOutboxPublish(measurement: TransportPublishMeasurement): void;
  recordOutboxDispatchLatency(
    measurement: OutboxDispatchLatencyMeasurement,
  ): void;
  recordQueueStall(queueName: TransportJob['queueName']): void;
  recordWorkerProcessStart(): void;
}

export interface TransportMetricsOptions {
  /** Injection seam for SDK-backed production meters and deterministic tests. */
  readonly meter?: Meter;
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function transportAttributes(job: TransportJob): Attributes {
  return {
    job_name: job.jobName,
    queue_name: job.queueName,
  };
}

function outcomeAttributes(
  measurement: TransportHandlerMeasurement | TransportPublishMeasurement,
): Attributes {
  const attributes: Attributes = {
    ...transportAttributes(measurement),
    outcome: measurement.outcome,
  };

  return 'errorClass' in measurement
    ? { ...attributes, error_class: measurement.errorClass }
    : attributes;
}

export function createTransportMetrics(
  options: TransportMetricsOptions = {},
): TransportMetrics {
  const meter =
    options.meter ??
    metrics.getMeter('@pertexo/observability.transport', '0.0.0');
  const outboxClaimed = meter.createCounter(
    TRANSPORT_METRIC_NAME.outboxClaimed,
    {
      description: 'Outbox rows acquired by bounded dispatcher claims',
      unit: '{event}',
    },
  );
  const outboxClaimBatchSize = meter.createHistogram(
    TRANSPORT_METRIC_NAME.outboxClaimBatchSize,
    {
      description: 'Number of outbox rows acquired per claim operation',
      unit: '{event}',
    },
  );
  const outboxBacklog = meter.createGauge(TRANSPORT_METRIC_NAME.outboxBacklog, {
    description: 'Publishable, unclaimed rows in the PostgreSQL outbox',
    unit: '{event}',
  });
  const outboxOldestAge = meter.createGauge(
    TRANSPORT_METRIC_NAME.outboxOldestAge,
    {
      description: 'Age of the oldest publishable PostgreSQL outbox row',
      unit: 's',
    },
  );
  const outboxPublish = meter.createCounter(
    TRANSPORT_METRIC_NAME.outboxPublish,
    {
      description: 'Outbox publication attempts by bounded outcome class',
      unit: '{event}',
    },
  );
  const outboxDispatchLatency = meter.createHistogram(
    TRANSPORT_METRIC_NAME.outboxDispatchLatency,
    {
      description:
        'Seconds from outbox availability until durable publication acknowledgement',
      unit: 's',
    },
  );
  const outboxLeaseEvents = meter.createCounter(
    TRANSPORT_METRIC_NAME.outboxLeaseEvents,
    {
      description: 'Outbox lease expiry, reclaim, and exhaustion events',
      unit: '{event}',
    },
  );
  const handlerExecutions = meter.createCounter(
    TRANSPORT_METRIC_NAME.handlerExecutions,
    {
      description: 'Completed transport handler executions by outcome',
      unit: '{execution}',
    },
  );
  const handlerDuration = meter.createHistogram(
    TRANSPORT_METRIC_NAME.handlerDuration,
    {
      description: 'Transport handler execution duration by outcome',
      unit: 's',
    },
  );
  const activeConcurrency = meter.createUpDownCounter(
    TRANSPORT_METRIC_NAME.activeConcurrency,
    {
      description: 'Currently active transport handlers',
      unit: '{handler}',
    },
  );
  const queueDepth = meter.createGauge(TRANSPORT_METRIC_NAME.queueDepth, {
    description: 'Waiting and delayed jobs observed in a transport queue',
    unit: '{job}',
  });
  const queueOldestJobAge = meter.createGauge(
    TRANSPORT_METRIC_NAME.queueOldestJobAge,
    {
      description: 'Age of the oldest waiting job in a transport queue',
      unit: 's',
    },
  );
  const queueStalls = meter.createCounter(TRANSPORT_METRIC_NAME.queueStalls, {
    description: 'BullMQ stalled deliveries by bounded queue name',
    unit: '{event}',
  });
  const consumerLifecycle = meter.createCounter(
    TRANSPORT_METRIC_NAME.consumerLifecycle,
    {
      description: 'Queue consumer readiness and bounded drain outcomes',
      unit: '{event}',
    },
  );
  const artifactCount = meter.createGauge(TRANSPORT_METRIC_NAME.artifactCount, {
    description: 'Artifact metadata rows by lifecycle status',
    unit: '{artifact}',
  });
  const artifactBytes = meter.createGauge(TRANSPORT_METRIC_NAME.artifactBytes, {
    description: 'Artifact bytes by lifecycle status',
    unit: 'By',
  });
  const workerProcessStarts = meter.createCounter(
    TRANSPORT_METRIC_NAME.workerProcessStarts,
    {
      description: 'Successful worker process compositions, including restarts',
      unit: '{process}',
    },
  );

  return Object.freeze({
    addActiveConcurrency(change: ActiveConcurrencyChange): void {
      const delta: number = change.delta;
      if (delta !== 1 && delta !== -1) {
        throw new RangeError('delta must be exactly 1 or -1');
      }
      activeConcurrency.add(delta, transportAttributes(change));
    },
    observeArtifacts(observation: ArtifactObservation): void {
      requireNonNegativeInteger(observation.count, 'count');
      requireNonNegativeInteger(observation.bytes, 'bytes');
      const attributes = { status: observation.status };
      artifactCount.record(observation.count, attributes);
      artifactBytes.record(observation.bytes, attributes);
    },
    observeOutbox(observation: OutboxObservation): void {
      requireNonNegativeInteger(observation.backlog, 'backlog');
      if (observation.oldestAgeSeconds !== undefined) {
        requireNonNegativeFinite(
          observation.oldestAgeSeconds,
          'oldestAgeSeconds',
        );
      }
      outboxBacklog.record(observation.backlog);
      if (observation.oldestAgeSeconds !== undefined) {
        outboxOldestAge.record(observation.oldestAgeSeconds);
      }
    },
    observeQueue(observation: QueueObservation): void {
      requireNonNegativeInteger(observation.depth, 'depth');
      requireNonNegativeFinite(
        observation.oldestJobAgeSeconds,
        'oldestJobAgeSeconds',
      );
      const attributes = { queue_name: observation.queueName };
      queueDepth.record(observation.depth, attributes);
      queueOldestJobAge.record(observation.oldestJobAgeSeconds, attributes);
    },
    recordHandlerFinished(measurement: TransportHandlerMeasurement): void {
      requireNonNegativeFinite(measurement.durationSeconds, 'durationSeconds');
      const attributes = outcomeAttributes(measurement);
      handlerExecutions.add(1, attributes);
      handlerDuration.record(measurement.durationSeconds, attributes);
    },
    recordConsumerLifecycle(measurement: ConsumerLifecycleMeasurement): void {
      consumerLifecycle.add(1, {
        event: measurement.event,
        queue_name: measurement.queueName,
      });
    },
    recordOutboxClaim(measurement: OutboxClaimMeasurement): void {
      requireNonNegativeInteger(measurement.batchSize, 'batchSize');
      outboxClaimed.add(measurement.batchSize);
      outboxClaimBatchSize.record(measurement.batchSize);
    },
    recordOutboxLeaseEvent(event: TransportLeaseEvent, count = 1): void {
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new RangeError('count must be a positive safe integer');
      }
      outboxLeaseEvents.add(count, { event });
    },
    recordOutboxPublish(measurement: TransportPublishMeasurement): void {
      outboxPublish.add(1, outcomeAttributes(measurement));
    },
    recordOutboxDispatchLatency(
      measurement: OutboxDispatchLatencyMeasurement,
    ): void {
      requireNonNegativeFinite(measurement.durationSeconds, 'durationSeconds');
      outboxDispatchLatency.record(measurement.durationSeconds, {
        ...transportAttributes(measurement),
        outcome: measurement.outcome,
      });
    },
    recordQueueStall(queueName: TransportJob['queueName']): void {
      queueStalls.add(1, { queue_name: queueName });
    },
    recordWorkerProcessStart(): void {
      workerProcessStarts.add(1);
    },
  });
}
