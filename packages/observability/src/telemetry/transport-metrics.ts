import { metrics, type Attributes, type Meter } from '@opentelemetry/api';
import type {
  TransportLeaseEvent,
  TransportJob,
  TransportPublishMeasurement,
  TransportHandlerMeasurement,
  OutboxClaimMeasurement,
  OutboxObservation,
  QueueObservation,
  ArtifactObservation,
  ExecutionStorageObservation,
  ConsumerLifecycleMeasurement,
  OutboxDispatchLatencyMeasurement,
  ActiveConcurrencyChange,
  TransportMetrics,
  TransportMetricsOptions,
} from './transport/contract.js';

export {
  type TransportErrorClass,
  type TransportLeaseEvent,
  type TransportJob,
  type TransportPublishMeasurement,
  type TransportHandlerMeasurement,
  type OutboxClaimMeasurement,
  type OutboxObservation,
  type QueueObservation,
  type ArtifactObservation,
  type ExecutionStorageObservation,
  type ConsumerLifecycleMeasurement,
  type OutboxDispatchLatencyMeasurement,
  type ActiveConcurrencyChange,
  type TransportMetrics,
  type TransportMetricsOptions,
} from './transport/contract.js';
export const TRANSPORT_METRIC_NAME = Object.freeze({
  artifactBytes: 'pertexo.transport.artifact.bytes',
  artifactCount: 'pertexo.transport.artifact.count',
  executionStorageBytes: 'pertexo.transport.execution_storage.bytes',
  executionStorageCount: 'pertexo.transport.execution_storage.count',
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
  workerProcessStartTime: 'pertexo.worker.process.start_time',
} as const);

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
  const {
    outboxClaimed,
    outboxClaimBatchSize,
    outboxBacklog,
    outboxOldestAge,
    outboxPublish,
    outboxDispatchLatency,
    outboxLeaseEvents,
    handlerExecutions,
    handlerDuration,
    activeConcurrency,
    queueDepth,
    queueOldestJobAge,
    queueStalls,
    consumerLifecycle,
    artifactCount,
    artifactBytes,
    executionStorageCount,
    executionStorageBytes,
    workerProcessStartTime,
  } = createTransportInstruments(meter);

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
    observeExecutionStorage(observation: ExecutionStorageObservation): void {
      requireNonNegativeInteger(observation.count, 'count');
      requireNonNegativeInteger(observation.bytes, 'bytes');
      const attributes = { surface: observation.surface };
      executionStorageCount.record(observation.count, attributes);
      executionStorageBytes.record(observation.bytes, attributes);
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
      workerProcessStartTime.record((options.now ?? Date.now)() / 1_000);
    },
  });
}

function createTransportInstruments(meter: Meter) {
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
  const executionStorageCount = meter.createHistogram(
    TRANSPORT_METRIC_NAME.executionStorageCount,
    {
      description:
        'Distribution of event and checkpoint rows per observed workspace',
      unit: '{record}',
    },
  );
  const executionStorageBytes = meter.createHistogram(
    TRANSPORT_METRIC_NAME.executionStorageBytes,
    {
      description:
        'Distribution of event payload and checkpoint state bytes per observed workspace',
      unit: 'By',
    },
  );
  const workerProcessStartTime = meter.createGauge(
    TRANSPORT_METRIC_NAME.workerProcessStartTime,
    {
      description: 'Unix time of this telemetry writer worker process start',
      unit: 's',
    },
  );

  return {
    outboxClaimed,
    outboxClaimBatchSize,
    outboxBacklog,
    outboxOldestAge,
    outboxPublish,
    outboxDispatchLatency,
    outboxLeaseEvents,
    handlerExecutions,
    handlerDuration,
    activeConcurrency,
    queueDepth,
    queueOldestJobAge,
    queueStalls,
    consumerLifecycle,
    artifactCount,
    artifactBytes,
    executionStorageCount,
    executionStorageBytes,
    workerProcessStartTime,
  };
}
