import type { Meter } from '@opentelemetry/api';

export type TransportErrorClass =
  'contract' | 'database' | 'redis' | 'timeout' | 'unavailable' | 'unknown';

export type TransportLeaseEvent = 'attempt_exhausted' | 'expired' | 'reclaimed';

export type TransportJob =
  | {
      readonly jobName: 'start-error-workflow';
      readonly queueName: 'maintenance';
    }
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
      readonly jobName: 'reconcile-unknown-outcome';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'replay-workflow-run';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'reconcile-workflow-triggers';
      readonly queueName: 'trigger-lifecycle';
    }
  | {
      readonly jobName: 'deliver-run-failure-notification';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'deliver-workspace-invitation';
      readonly queueName: 'maintenance';
    }
  | {
      readonly jobName: 'apply-connection-health-observation';
      readonly queueName: 'maintenance';
    };

export type TransportPublishMeasurement = TransportJob &
  (
    | { readonly outcome: 'deduplicated' | 'published' }
    | {
        readonly errorClass: TransportErrorClass;
        readonly outcome: 'failed' | 'outcome_unknown';
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

export interface ExecutionStorageObservation {
  readonly bytes: number;
  readonly count: number;
  readonly surface: 'checkpoint' | 'event';
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
  observeExecutionStorage(observation: ExecutionStorageObservation): void;
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
  readonly now?: () => number;
}
