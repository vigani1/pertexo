import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowAuthoringTelemetry,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringCounter,
  type WorkflowAuthoringHistogram,
  type WorkflowAuthoringMeter,
  type WorkflowAuthoringOperation,
  type WorkflowAuthoringSpan,
  type WorkflowAuthoringTracer,
} from '../../src/workflow-authoring/telemetry.js';

describe('workflow authoring telemetry', () => {
  it('records exact bounded success and failure measurements and ends each owning span once', async () => {
    const fixture = telemetryFixture([1_000, 1_250, 2_000, 2_125]);
    const telemetry = createWorkflowAuthoringTelemetry(fixture.options);
    const failure = new Error('private authoring failure');

    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.draftGet, () =>
        Promise.resolve('ok'),
      ),
    ).resolves.toBe('ok');
    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.draftSave, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);

    expect(fixture.counter.add.mock.calls).toEqual([
      [
        1,
        {
          operation: WORKFLOW_AUTHORING_OPERATION.draftGet,
          outcome: 'succeeded',
        },
      ],
      [
        1,
        {
          operation: WORKFLOW_AUTHORING_OPERATION.draftSave,
          outcome: 'failed',
        },
      ],
    ]);
    expect(fixture.histogram.record.mock.calls).toEqual([
      [
        0.25,
        {
          operation: WORKFLOW_AUTHORING_OPERATION.draftGet,
          outcome: 'succeeded',
        },
      ],
      [
        0.125,
        {
          operation: WORKFLOW_AUTHORING_OPERATION.draftSave,
          outcome: 'failed',
        },
      ],
    ]);
    expect(fixture.spans).toHaveLength(2);
    expect(fixture.spans[0]?.setAttribute.mock.calls).toEqual([
      ['operation', WORKFLOW_AUTHORING_OPERATION.draftGet],
      ['outcome', 'succeeded'],
    ]);
    expect(fixture.spans[1]?.setAttribute.mock.calls).toEqual([
      ['operation', WORKFLOW_AUTHORING_OPERATION.draftSave],
      ['outcome', 'failed'],
    ]);
    expect(fixture.spans[0]?.end).toHaveBeenCalledOnce();
    expect(fixture.spans[1]?.end).toHaveBeenCalledOnce();
    expect(
      JSON.stringify([
        fixture.counter.add.mock.calls,
        fixture.histogram.record.mock.calls,
        fixture.spans.flatMap(
          (activeSpan) => activeSpan.setAttribute.mock.calls,
        ),
      ]),
    ).not.toContain(failure.message);
  });

  it('contains instrument, clock, attribute, recording, and span-end failures', async () => {
    const meterFailure = createWorkflowAuthoringTelemetry({
      meter: {
        createCounter: () => {
          throw new Error('meter unavailable');
        },
        createHistogram: vi.fn(),
      },
      tracer: { startActiveSpan: vi.fn() },
    });
    await expect(
      meterFailure.measure(WORKFLOW_AUTHORING_OPERATION.create, () =>
        Promise.resolve('created'),
      ),
    ).resolves.toBe('created');

    const fixture = telemetryFixture([Number.NaN]);
    fixture.options.monotonicNow = () => {
      throw new Error('clock unavailable');
    };
    fixture.counter.add.mockImplementation(() => {
      throw new Error('counter unavailable');
    });
    const failedSpan = span();
    failedSpan.end.mockImplementation(() => {
      throw new Error('span end unavailable');
    });
    failedSpan.setAttribute.mockImplementation(() => {
      throw new Error('span attribute unavailable');
    });
    fixture.spansFactory.mockReturnValue(failedSpan);
    const telemetry = createWorkflowAuthoringTelemetry(fixture.options);

    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.create, () =>
        Promise.resolve('created'),
      ),
    ).resolves.toBe('created');
    expect(fixture.counter.add).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a synchronous trace failure before its callback',
      startActiveSpan: <T>(): Promise<T> => {
        throw new Error('trace failed before callback');
      },
    },
    {
      name: 'a synchronous trace failure after its callback',
      startActiveSpan: <T>(
        _name: string,
        callback: (activeSpan: WorkflowAuthoringSpan) => Promise<T>,
      ): Promise<T> => {
        void callback(span());
        throw new Error('trace failed after callback');
      },
    },
    {
      name: 'an asynchronous trace failure before its callback',
      startActiveSpan: <T>(): Promise<T> =>
        Promise.reject(new Error('trace rejected before callback')),
    },
    {
      name: 'an asynchronous trace failure after its callback',
      startActiveSpan: <T>(
        _name: string,
        callback: (activeSpan: WorkflowAuthoringSpan) => Promise<T>,
      ): Promise<T> => {
        void callback(span());
        return Promise.reject(new Error('trace rejected after callback'));
      },
    },
  ] satisfies readonly Readonly<{
    name: string;
    startActiveSpan: WorkflowAuthoringTracer['startActiveSpan'];
  }>[])(
    'runs business work once through $name',
    async ({ startActiveSpan }) => {
      const fixture = telemetryFixture([100, 110]);
      const telemetry = createWorkflowAuthoringTelemetry({
        ...fixture.options,
        tracer: { startActiveSpan },
      });
      const authoritative = Object.freeze({ id: 'authoritative-result' });
      const work = vi.fn(() => Promise.resolve(authoritative));

      await expect(
        telemetry.measure(WORKFLOW_AUTHORING_OPERATION.create, work),
      ).resolves.toBe(authoritative);
      expect(work).toHaveBeenCalledOnce();
      expect(fixture.counter.add).toHaveBeenCalledOnce();
      expect(fixture.histogram.record).toHaveBeenCalledOnce();
    },
  );

  it('preserves the exact business rejection when tracing fails after starting work', async () => {
    const fixture = telemetryFixture([100, 110]);
    const failure = new Error('authoritative rejection');
    const work = vi.fn(() => Promise.reject(failure));
    const telemetry = createWorkflowAuthoringTelemetry({
      ...fixture.options,
      tracer: {
        startActiveSpan: (_name, callback) => {
          void callback(span());
          throw new Error('diagnostic rejection');
        },
      },
    });

    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.publish, work),
    ).rejects.toBe(failure);
    expect(work).toHaveBeenCalledOnce();
    expect(fixture.counter.add).toHaveBeenCalledWith(1, {
      operation: WORKFLOW_AUTHORING_OPERATION.publish,
      outcome: 'failed',
    });
  });

  it('returns one authoritative promise and ends non-owning spans when tracing repeats its callback', async () => {
    const fixture = telemetryFixture([100, 110]);
    const firstSpan = span();
    const repeatedSpan = span();
    const work = vi.fn(() => Promise.resolve('saved'));
    const telemetry = createWorkflowAuthoringTelemetry({
      ...fixture.options,
      tracer: {
        startActiveSpan: (_name, callback) => {
          const first = callback(firstSpan);
          expect(callback(firstSpan)).toBe(first);
          expect(callback(repeatedSpan)).toBe(first);
          return first;
        },
      },
    });

    await expect(
      telemetry.measure(WORKFLOW_AUTHORING_OPERATION.draftSave, work),
    ).resolves.toBe('saved');
    expect(work).toHaveBeenCalledOnce();
    expect(firstSpan.end).toHaveBeenCalledOnce();
    expect(repeatedSpan.end).toHaveBeenCalledOnce();
    expect(fixture.counter.add).toHaveBeenCalledOnce();
    expect(fixture.histogram.record).toHaveBeenCalledOnce();
  });
});

function span() {
  return {
    end: vi.fn(),
    setAttribute: vi.fn(),
  } satisfies WorkflowAuthoringSpan;
}

function telemetryFixture(nowValues: readonly number[]) {
  const counter: WorkflowAuthoringCounter = { add: vi.fn() };
  const histogram: WorkflowAuthoringHistogram = { record: vi.fn() };
  const meter: WorkflowAuthoringMeter = {
    createCounter: vi.fn().mockReturnValue(counter),
    createHistogram: vi.fn().mockReturnValue(histogram),
  };
  const spans: ReturnType<typeof span>[] = [];
  const spansFactory = vi.fn(() => span());
  const tracer: WorkflowAuthoringTracer = {
    startActiveSpan: async <T>(
      _name: `pertexo.workflow_authoring.${WorkflowAuthoringOperation}`,
      callback: (activeSpan: WorkflowAuthoringSpan) => Promise<T>,
    ): Promise<T> => {
      const activeSpan = spansFactory();
      spans.push(activeSpan);
      return callback(activeSpan);
    },
  };
  const values = [...nowValues];
  const options: {
    meter: WorkflowAuthoringMeter;
    monotonicNow: () => number;
    tracer: WorkflowAuthoringTracer;
  } = {
    meter,
    monotonicNow: () => values.shift() ?? 0,
    tracer,
  };
  return {
    counter: counter as { add: ReturnType<typeof vi.fn> },
    histogram: histogram as { record: ReturnType<typeof vi.fn> },
    options,
    spans,
    spansFactory,
  };
}
