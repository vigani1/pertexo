import { expect, it } from 'vitest';
import {
  createTransportMetrics,
  TRANSPORT_METRIC_NAME,
} from '../../../src/telemetry/transport-metrics.js';
import { metricHarness, values, recordedMeasurements } from './fixture.js';

export function registerRecordsStallsDispatchLatencyLifecycleArtifact(): void {
  it('records stalls, dispatch latency, lifecycle, and artifact capacity with bounded labels', () => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({ meter: harness.meter });

    metrics.recordQueueStall('node-attempts');
    metrics.recordConsumerLifecycle({
      event: 'drain_graceful',
      queueName: 'node-attempts',
    });
    metrics.recordOutboxDispatchLatency({
      durationSeconds: 1.25,
      jobName: 'execute-node-attempt',
      outcome: 'published',
      queueName: 'node-attempts',
    });
    metrics.observeArtifacts({ bytes: 4096, count: 3, status: 'available' });
    metrics.observeExecutionStorage({
      bytes: 8192,
      count: 12,
      surface: 'event',
    });

    expect(values(harness.counters, TRANSPORT_METRIC_NAME.queueStalls)).toEqual(
      [{ attributes: { queue_name: 'node-attempts' }, value: 1 }],
    );
    expect(
      values(harness.counters, TRANSPORT_METRIC_NAME.consumerLifecycle),
    ).toEqual([
      {
        attributes: {
          event: 'drain_graceful',
          queue_name: 'node-attempts',
        },
        value: 1,
      },
    ]);
    expect(
      values(harness.histograms, TRANSPORT_METRIC_NAME.outboxDispatchLatency),
    ).toEqual([
      {
        attributes: {
          job_name: 'execute-node-attempt',
          outcome: 'published',
          queue_name: 'node-attempts',
        },
        value: 1.25,
      },
    ]);
    expect(values(harness.gauges, TRANSPORT_METRIC_NAME.artifactCount)).toEqual(
      [{ attributes: { status: 'available' }, value: 3 }],
    );
    expect(values(harness.gauges, TRANSPORT_METRIC_NAME.artifactBytes)).toEqual(
      [{ attributes: { status: 'available' }, value: 4096 }],
    );
    expect(
      values(harness.histograms, TRANSPORT_METRIC_NAME.executionStorageCount),
    ).toEqual([{ attributes: { surface: 'event' }, value: 12 }]);
    expect(
      values(harness.histograms, TRANSPORT_METRIC_NAME.executionStorageBytes),
    ).toEqual([{ attributes: { surface: 'event' }, value: 8192 }]);
    const serialized = JSON.stringify([
      ...harness.counters.values(),
      ...harness.gauges.values(),
      ...harness.histograms.values(),
    ]);
    expect(serialized).not.toContain('workspace_id');
    expect(serialized).not.toContain('artifact_id');
    expect(serialized).not.toContain('outbox_event_id');
  });

  it('records this writer process start time without dynamic labels', () => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({
      meter: harness.meter,
      now: () => 1_750_000_000_000,
    });

    metrics.recordWorkerProcessStart();
    metrics.recordWorkerProcessStart();

    expect(
      values(harness.gauges, TRANSPORT_METRIC_NAME.workerProcessStartTime),
    ).toEqual([
      { attributes: undefined, value: 1_750_000_000 },
      { attributes: undefined, value: 1_750_000_000 },
    ]);
  });

  it.each([
    {
      name: 'negative claim size',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.recordOutboxClaim({ batchSize: -1 });
      },
    },
    {
      name: 'negative backlog',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.observeOutbox({ backlog: -1 });
      },
    },
    {
      name: 'valid backlog followed by an invalid age',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.observeOutbox({ backlog: 4, oldestAgeSeconds: -1 });
      },
    },
    {
      name: 'valid artifact count followed by invalid bytes',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.observeArtifacts({ bytes: -1, count: 2, status: 'available' });
      },
    },
    {
      name: 'valid execution count followed by invalid bytes',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.observeExecutionStorage({
          bytes: -1,
          count: 2,
          surface: 'event',
        });
      },
    },
    {
      name: 'non-positive lease count',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.recordOutboxLeaseEvent('expired', 0);
      },
    },
    {
      name: 'non-finite handler duration',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.recordHandlerFinished({
          durationSeconds: Number.NaN,
          jobName: 'replay-workflow-run',
          outcome: 'completed',
          queueName: 'maintenance',
        });
      },
    },
    {
      name: 'fractional queue depth',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.observeQueue({
          depth: 1.5,
          oldestJobAgeSeconds: 0,
          queueName: 'maintenance',
        });
      },
    },
    {
      name: 'valid queue depth followed by an invalid age',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.observeQueue({
          depth: 1,
          oldestJobAgeSeconds: -1,
          queueName: 'maintenance',
        });
      },
    },
    {
      name: 'invalid active-concurrency delta',
      act: (metrics: ReturnType<typeof createTransportMetrics>) => {
        metrics.addActiveConcurrency({
          // @ts-expect-error exercises the runtime boundary for untyped callers.
          delta: 0,
          jobName: 'replay-workflow-run',
          queueName: 'maintenance',
        });
      },
    },
  ])('rejects $name before any instrument write', ({ act }) => {
    const harness = metricHarness();
    const metrics = createTransportMetrics({ meter: harness.meter });

    expect(() => {
      act(metrics);
    }).toThrow(RangeError);
    expect(recordedMeasurements(harness)).toEqual([]);
  });
}
