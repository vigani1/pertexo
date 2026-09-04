import { describe, expect, it } from 'vitest';

import * as queue from '../src/index.js';

describe('public package surface', () => {
  it('matches the reviewed root runtime export manifest', () => {
    expect(Object.keys(queue).sort()).toEqual([
      'AdvanceWorkflowRunJobSchema',
      'BullMqQueueConsumer',
      'BullMqQueueProducer',
      'DeliverRunFailureNotificationJobSchema',
      'ExecuteNodeAttemptJobSchema',
      'ExecutePreviewAttemptJobSchema',
      'ExpireArtifactsJobSchema',
      'InvalidQueueDeliveryError',
      'JOB_NAME',
      'QUEUE_CLASS_DEFAULTS',
      'QUEUE_FOR_JOB',
      'QUEUE_JOB_REGISTRY',
      'QUEUE_NAME',
      'QUEUE_SCHEMA_VERSION',
      'QueueConfigurationError',
      'QueueConsumerConfigurationError',
      'QueueConsumerDrainError',
      'QueueConsumerNotReadyError',
      'QueueJobTimeoutError',
      'QueueNotReadyError',
      'REDIS_METRIC_NAME',
      'ReconcilePreviewAttemptJobSchema',
      'ReconcileUnknownOutcomeJobSchema',
      'ReconcileWorkflowTriggersJobSchema',
      'RedisRunEventNotificationPublisher',
      'ReplayWorkflowRunJobSchema',
      'RunEventNotificationConfigurationError',
      'RunEventNotificationPublishError',
      'SweepExpiredPreviewsJobSchema',
      'UnknownQueueJobError',
      'createProductionRedisTelemetryObserver',
      'createQueueConsumer',
      'createQueueProducer',
      'createRedisTelemetryObserver',
      'encodeRunEventReference',
      'encodeRunEventResync',
      'jobIdForOutboxEvent',
      'normalizeRedisEndpoint',
      'parseQueueJob',
      'runEventChannel',
      'safeParseQueueJob',
      'unrecoverableQueueError',
    ]);
  });
});
