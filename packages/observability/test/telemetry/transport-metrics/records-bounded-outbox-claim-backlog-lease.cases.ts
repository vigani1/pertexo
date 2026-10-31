import { expect, it } from 'vitest';
import {
  createTransportMetrics,
  TRANSPORT_METRIC_NAME,
} from '../../../src/telemetry/transport-metrics.js';
import { metricHarness, values } from './fixture.js';

export function registerRecordsBoundedOutboxClaimBacklogLease(): void {
  it('records bounded outbox claim, backlog, and lease measurements', () => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({ meter: harness.meter });

    metrics.recordOutboxClaim({ batchSize: 4 });
    metrics.observeOutbox({ backlog: 23, oldestAgeSeconds: 7.5 });
    metrics.recordOutboxLeaseEvent('expired');
    metrics.recordOutboxLeaseEvent('reclaimed');
    metrics.recordOutboxLeaseEvent('publication_failed', 2);

    expect(
      values(harness.counters, TRANSPORT_METRIC_NAME.outboxClaimed),
    ).toEqual([{ attributes: undefined, value: 4 }]);
    expect(
      values(harness.histograms, TRANSPORT_METRIC_NAME.outboxClaimBatchSize),
    ).toEqual([{ attributes: undefined, value: 4 }]);
    expect(values(harness.gauges, TRANSPORT_METRIC_NAME.outboxBacklog)).toEqual(
      [{ attributes: undefined, value: 23 }],
    );
    expect(
      values(harness.gauges, TRANSPORT_METRIC_NAME.outboxOldestAge),
    ).toEqual([{ attributes: undefined, value: 7.5 }]);
    expect(
      values(harness.counters, TRANSPORT_METRIC_NAME.outboxLeaseEvents),
    ).toEqual([
      { attributes: { event: 'expired' }, value: 1 },
      { attributes: { event: 'reclaimed' }, value: 1 },
      { attributes: { event: 'publication_failed' }, value: 2 },
    ]);
  });

  it('does not report a false zero age when backlog age is unknown', () => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({ meter: harness.meter });

    metrics.observeOutbox({ backlog: 23 });

    expect(
      values(harness.gauges, TRANSPORT_METRIC_NAME.outboxOldestAge),
    ).toEqual([]);
  });

  it('records publish results with only fixed transport dimensions', () => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({ meter: harness.meter });

    metrics.recordOutboxPublish({
      jobName: 'execute-node-attempt',
      outcome: 'published',
      queueName: 'node-attempts',
    });
    metrics.recordOutboxPublish({
      errorClass: 'redis',
      jobName: 'execute-node-attempt',
      outcome: 'failed',
      queueName: 'node-attempts',
    });

    expect(
      values(harness.counters, TRANSPORT_METRIC_NAME.outboxPublish),
    ).toEqual([
      {
        attributes: {
          job_name: 'execute-node-attempt',
          outcome: 'published',
          queue_name: 'node-attempts',
        },
        value: 1,
      },
      {
        attributes: {
          error_class: 'redis',
          job_name: 'execute-node-attempt',
          outcome: 'failed',
          queue_name: 'node-attempts',
        },
        value: 1,
      },
    ]);
  });

  it('records handler outcome, latency, concurrency, and queue observations', () => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({ meter: harness.meter });
    const transport = {
      jobName: 'advance-workflow-run' as const,
      queueName: 'workflow-coordinator' as const,
    };

    metrics.addActiveConcurrency({ ...transport, delta: 1 });
    metrics.recordHandlerFinished({
      ...transport,
      durationSeconds: 0.125,
      outcome: 'completed',
    });
    metrics.recordHandlerFinished({
      ...transport,
      durationSeconds: 2,
      errorClass: 'timeout',
      outcome: 'failed',
    });
    metrics.observeQueue({
      depth: 11,
      oldestJobAgeSeconds: 3.25,
      queueName: transport.queueName,
    });
    metrics.addActiveConcurrency({ ...transport, delta: -1 });

    expect(
      values(harness.upDownCounters, TRANSPORT_METRIC_NAME.activeConcurrency),
    ).toEqual([
      {
        attributes: {
          job_name: transport.jobName,
          queue_name: transport.queueName,
        },
        value: 1,
      },
      {
        attributes: {
          job_name: transport.jobName,
          queue_name: transport.queueName,
        },
        value: -1,
      },
    ]);
    expect(
      values(harness.counters, TRANSPORT_METRIC_NAME.handlerExecutions),
    ).toHaveLength(2);
    expect(
      values(harness.histograms, TRANSPORT_METRIC_NAME.handlerDuration),
    ).toEqual([
      {
        attributes: {
          job_name: transport.jobName,
          outcome: 'completed',
          queue_name: transport.queueName,
        },
        value: 0.125,
      },
      {
        attributes: {
          error_class: 'timeout',
          job_name: transport.jobName,
          outcome: 'failed',
          queue_name: transport.queueName,
        },
        value: 2,
      },
    ]);
    expect(values(harness.gauges, TRANSPORT_METRIC_NAME.queueDepth)).toEqual([
      {
        attributes: { queue_name: transport.queueName },
        value: 11,
      },
    ]);
    expect(
      values(harness.gauges, TRANSPORT_METRIC_NAME.queueOldestJobAge),
    ).toEqual([
      {
        attributes: { queue_name: transport.queueName },
        value: 3.25,
      },
    ]);
  });
}
