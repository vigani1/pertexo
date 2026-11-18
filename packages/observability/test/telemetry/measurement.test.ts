import { describe, expect, it } from 'vitest';

import { measureOperation } from '../../src/telemetry/measurement.js';

/**
 * The tracers here stand in for a broken OpenTelemetry SDK: the real one
 * never throws, rejects or repeats its callback on demand, and these are the
 * cases the measurement must survive without changing the operation's result.
 */

type Recorded = Readonly<{
  outcome: string;
  seconds: number;
  span: RecordingSpan | undefined;
}>;

class RecordingSpan {
  public readonly attributes: (readonly [string, string])[] = [];
  public ends = 0;

  public constructor(
    private readonly failures: Readonly<{
      attribute?: boolean;
      end?: boolean;
    }> = {},
  ) {}

  public setAttribute(name: string, value: string): void {
    this.attributes.push([name, value]);
    if (this.failures.attribute === true)
      throw new Error('span attribute unavailable');
  }

  public end(): void {
    this.ends += 1;
    if (this.failures.end === true) throw new Error('span end unavailable');
  }
}

function measured<T>(
  work: () => Promise<T>,
  options: Readonly<{
    trace?: (run: (span?: RecordingSpan) => Promise<T>) => Promise<T>;
    clock?: readonly number[] | (() => number);
    recordFails?: boolean;
  }> = {},
) {
  const recorded: Recorded[] = [];
  let calls = 0;
  const clock =
    typeof options.clock === 'function'
      ? options.clock
      : readings(options.clock ?? []);
  const result = measureOperation<T, RecordingSpan>({
    operation: 'workflow.draft.save',
    work: () => {
      calls += 1;
      return work();
    },
    monotonicNow: clock,
    trace: options.trace ?? ((run) => run(new RecordingSpan())),
    record: (measurement) => {
      recorded.push(measurement);
      if (options.recordFails === true)
        throw new Error('metrics sink unavailable');
    },
  });
  return { result, recorded, calls: () => calls };
}

/** A monotonic clock that returns these readings in turn, then zero. */
function readings(values: readonly number[]): () => number {
  const remaining = [...values];
  return () => remaining.shift() ?? 0;
}

describe('measuring an operation', () => {
  it('records the outcome and monotonic seconds, and labels and ends its own span once', async () => {
    const succeeded = new RecordingSpan();
    const ok = measured(() => Promise.resolve('saved'), {
      clock: [1_000, 1_250],
      trace: (run) => run(succeeded),
    });
    await expect(ok.result).resolves.toBe('saved');

    const failedSpan = new RecordingSpan();
    const failure = new Error('private authoring failure');
    const failed = measured(() => Promise.reject(failure), {
      clock: [2_000, 2_125],
      trace: (run) => run(failedSpan),
    });
    await expect(failed.result).rejects.toBe(failure);

    expect(ok.recorded).toEqual([
      { outcome: 'succeeded', seconds: 0.25, span: succeeded },
    ]);
    expect(failed.recorded).toEqual([
      { outcome: 'failed', seconds: 0.125, span: failedSpan },
    ]);
    expect(succeeded.attributes).toEqual([
      ['operation', 'workflow.draft.save'],
      ['outcome', 'succeeded'],
    ]);
    expect(failedSpan.attributes).toEqual([
      ['operation', 'workflow.draft.save'],
      ['outcome', 'failed'],
    ]);
    expect([succeeded.ends, failedSpan.ends]).toEqual([1, 1]);
    expect(JSON.stringify(failedSpan.attributes)).not.toContain(
      failure.message,
    );
  });

  it('keeps the result when the clock, the span and the metrics sink all fail', async () => {
    const span = new RecordingSpan({ attribute: true, end: true });
    const run = measured(() => Promise.resolve('created'), {
      clock: () => {
        throw new Error('clock unavailable');
      },
      recordFails: true,
      trace: (start) => start(span),
    });

    await expect(run.result).resolves.toBe('created');
    expect(run.recorded).toEqual([{ outcome: 'succeeded', seconds: 0, span }]);
    expect(span.ends).toBe(1);
  });

  it('counts a non-finite clock reading as zero seconds', async () => {
    const run = measured(() => Promise.resolve('created'), {
      clock: [Number.NaN, Number.NaN],
    });

    await expect(run.result).resolves.toBe('created');
    expect(run.recorded[0]?.seconds).toBe(0);
  });

  it('keeps a failure when the span status and end both fail', async () => {
    const failure = new Error('acceptance failed');
    const span = new RecordingSpan({ attribute: true, end: true });
    const run = measured(() => Promise.reject(failure), {
      recordFails: true,
      trace: (start) => start(span),
    });

    await expect(run.result).rejects.toBe(failure);
    expect(run.recorded.map(({ outcome }) => outcome)).toEqual(['failed']);
    expect(span.ends).toBe(1);
  });

  it.each([
    {
      name: 'throws before its callback',
      trace: (): Promise<string> => {
        throw new Error('trace failed before callback');
      },
    },
    {
      name: 'throws after its callback',
      trace: (run: (span?: RecordingSpan) => Promise<string>) => {
        void run(new RecordingSpan());
        throw new Error('trace failed after callback');
      },
    },
    {
      name: 'rejects before its callback',
      trace: (): Promise<string> =>
        Promise.reject(new Error('trace rejected before callback')),
    },
    {
      name: 'rejects after its callback',
      trace: (run: (span?: RecordingSpan) => Promise<string>) => {
        void run(new RecordingSpan());
        return Promise.reject(new Error('trace rejected after callback'));
      },
    },
  ])('runs the work exactly once when the tracer $name', async ({ trace }) => {
    const run = measured(() => Promise.resolve('authoritative'), {
      clock: [100, 110],
      trace,
    });

    await expect(run.result).resolves.toBe('authoritative');
    expect(run.calls()).toBe(1);
    expect(run.recorded.map(({ outcome }) => outcome)).toEqual(['succeeded']);
  });

  it('keeps the exact business rejection when the tracer throws after starting the work', async () => {
    const failure = new Error('authoritative rejection');
    const run = measured(() => Promise.reject(failure), {
      trace: (start) => {
        void start(new RecordingSpan()).catch(() => undefined);
        throw new Error('diagnostic rejection');
      },
    });

    await expect(run.result).rejects.toBe(failure);
    expect(run.calls()).toBe(1);
    expect(run.recorded.map(({ outcome }) => outcome)).toEqual(['failed']);
  });

  it('returns one promise and ends a repeated callback span when the tracer calls back twice', async () => {
    const owning = new RecordingSpan();
    const repeated = new RecordingSpan();
    const promises: Promise<string>[] = [];
    const run = measured(() => Promise.resolve('saved'), {
      trace: (start) => {
        const first = start(owning);
        promises.push(first, start(owning), start(repeated));
        return first;
      },
    });

    await expect(run.result).resolves.toBe('saved');
    expect(new Set([run.result, ...promises]).size).toBe(1);
    expect(run.calls()).toBe(1);
    expect([owning.ends, repeated.ends]).toEqual([1, 1]);
    expect(run.recorded).toHaveLength(1);
  });
});
