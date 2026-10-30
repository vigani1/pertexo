import { transportMetrics } from '../support/transport/metrics.js';
import { JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { createQueueMetricsObserver } from '../../src/transport/metrics-adapter.js';

describe('queue transport metrics adapter', () => {
  it('pairs active concurrency and records successful handler latency', () => {
    const selected = transportMetrics();
    const observer = createQueueMetricsObserver(selected);
    const job = {
      jobName: JOB_NAME.advanceWorkflowRun,
      queueName: QUEUE_NAME.workflowCoordinator,
    } as const;

    observer.handlerStarted(job);
    observer.handlerFinished({
      ...job,
      durationSeconds: 0.25,
      outcome: 'completed',
    });

    expect(selected.addActiveConcurrency).toHaveBeenNthCalledWith(1, {
      ...job,
      delta: 1,
    });
    expect(selected.recordHandlerFinished).toHaveBeenCalledWith({
      ...job,
      durationSeconds: 0.25,
      outcome: 'completed',
    });
    expect(selected.addActiveConcurrency).toHaveBeenNthCalledWith(2, {
      ...job,
      delta: -1,
    });
  });

  it.each([
    ['timeout', 'timeout'],
    ['drain', 'unavailable'],
    ['transport', 'unavailable'],
    ['handler', 'unknown'],
  ] as const)(
    'maps %s failures to the bounded %s error class',
    (failureClass, errorClass) => {
      const selected = transportMetrics();
      const observer = createQueueMetricsObserver(selected);

      observer.handlerStarted({
        jobName: JOB_NAME.executeNodeAttempt,
        queueName: QUEUE_NAME.nodeAttempts,
      });
      observer.handlerFinished({
        durationSeconds: 1,
        failureClass,
        jobName: JOB_NAME.executeNodeAttempt,
        outcome: 'failed',
        queueName: QUEUE_NAME.nodeAttempts,
      });

      expect(selected.recordHandlerFinished).toHaveBeenCalledWith({
        durationSeconds: 1,
        errorClass,
        jobName: JOB_NAME.executeNodeAttempt,
        outcome: 'failed',
        queueName: QUEUE_NAME.nodeAttempts,
      });
    },
  );

  it('decrements concurrency even when completion recording fails', () => {
    const selected = transportMetrics();
    vi.mocked(selected.recordHandlerFinished).mockImplementation(() => {
      throw new Error('meter rejected observation');
    });
    const observer = createQueueMetricsObserver(selected);
    const job = {
      jobName: JOB_NAME.replayWorkflowRun,
      queueName: QUEUE_NAME.maintenance,
    } as const;

    observer.handlerStarted(job);
    expect(() => {
      observer.handlerFinished({
        ...job,
        durationSeconds: 0,
        outcome: 'completed',
      });
    }).toThrow('meter rejected observation');
    expect(selected.addActiveConcurrency).toHaveBeenLastCalledWith({
      ...job,
      delta: -1,
    });
  });

  it('maps consumer stalls and lifecycle without dynamic identifiers', () => {
    const selected = transportMetrics();
    const observer = createQueueMetricsObserver(selected);

    observer.jobStalled?.({ queueName: QUEUE_NAME.nodeAttempts });
    observer.consumerLifecycle?.({
      event: 'drain_graceful',
      queueName: QUEUE_NAME.nodeAttempts,
    });

    expect(selected.recordQueueStall).toHaveBeenCalledWith(
      QUEUE_NAME.nodeAttempts,
    );
    expect(selected.recordConsumerLifecycle).toHaveBeenCalledWith({
      event: 'drain_graceful',
      queueName: QUEUE_NAME.nodeAttempts,
    });
  });
});
