import type { Meter } from '@opentelemetry/api';
import { vi } from 'vitest';

const pg = vi.hoisted(() => {
  class FakePool {
    static instances: FakePool[] = [];
    static endFailures: { readonly error: unknown }[] = [];
    static connectOutcomes: (
      | Readonly<{
          kind: 'reject';
          error: Error;
          release?: (destroy?: boolean | Error) => void;
        }>
      | Readonly<{
          kind: 'resolve';
          client: { release(destroy?: boolean | Error): void };
          release?: (destroy?: boolean | Error) => void;
        }>
    )[] = [];
    static queryErrors: unknown[] = [];
    static queryResults: { rows: { pid: number }[] }[] = [];
    static queryOutcomes: (
      | Readonly<{ kind: 'reject'; error: unknown }>
      | Readonly<{
          kind: 'resolve';
          result: { rows: { pid: number }[] };
        }>
      | Readonly<{
          kind: 'return';
          promise: Promise<{ rows: { pid: number }[] }>;
        }>
    )[] = [];
    readonly options: Readonly<{
      idle_in_transaction_session_timeout?: number;
      lock_timeout?: number;
      max: number;
      query_timeout?: number;
      statement_timeout?: false | number;
    }>;
    readonly queries: string[] = [];
    readonly queryValues: unknown[][] = [];
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    endCalls = 0;
    endOutcome: Readonly<{ kind: 'reject'; error: unknown }> | undefined;
    private readonly listeners = new Map<
      string,
      ((value: unknown) => void)[]
    >();

    constructor(config: {
      idle_in_transaction_session_timeout?: number;
      lock_timeout?: number;
      max?: number;
      query_timeout?: number;
      statement_timeout?: false | number;
    }) {
      this.options = { ...config, max: config.max ?? 10 };
      FakePool.instances.push(this);
    }

    on(event: string, listener: (value: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, value: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) listener(value);
    }

    connect(
      callback?: (
        error: Error | undefined,
        client: { release(destroy?: boolean | Error): void } | undefined,
        release: (destroy?: boolean | Error) => void,
      ) => void,
    ): Promise<{ release(destroy?: boolean | Error): void }> | undefined {
      const outcome = FakePool.connectOutcomes.shift() ?? {
        kind: 'reject' as const,
        error: new Error('Fake pool connect is not implemented'),
      };
      const release = outcome.release ?? (() => undefined);
      if (callback !== undefined) {
        queueMicrotask(() => {
          if (outcome.kind === 'reject')
            callback(outcome.error, undefined, release);
          else callback(undefined, outcome.client, release);
        });
        return;
      }
      return outcome.kind === 'reject'
        ? Promise.reject(outcome.error)
        : Promise.resolve(outcome.client);
    }

    query(
      query: string,
      values?: unknown[],
    ): Promise<{ rows: { pid: number }[] }> {
      this.queries.push(query);
      if (values !== undefined) this.queryValues.push(values);
      const outcome = FakePool.queryOutcomes.shift();
      if (outcome?.kind === 'reject') {
        // Deliberately exercise hostile non-Error adapter rejections.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(outcome.error);
      }
      if (outcome?.kind === 'resolve') return Promise.resolve(outcome.result);
      if (outcome?.kind === 'return') return outcome.promise;
      const error = FakePool.queryErrors.shift();
      // Exercise bounded telemetry for hostile non-Error adapter rejections.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (error !== undefined) return Promise.reject(error);
      if (Array.isArray(values?.[0]) && (values[0] as unknown[]).length === 0)
        return Promise.resolve({ rows: [] });
      return Promise.resolve(FakePool.queryResults.shift() ?? { rows: [] });
    }

    end(): Promise<void> {
      this.endCalls += 1;
      if (this.endOutcome?.kind === 'reject') {
        // Deliberately exercise hostile non-Error adapter rejections.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(this.endOutcome.error);
      }
      const failure = FakePool.endFailures.shift();
      // Deliberately exercise hostile non-Error adapter rejections.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (failure !== undefined) return Promise.reject(failure.error);
      return Promise.resolve();
    }
  }

  return { FakePool };
});

vi.mock('pg', () => ({ Pool: pg.FakePool }));

interface Measurement {
  readonly attributes?: Record<string, string>;
  readonly value: number;
}

export function fakeMeter(): {
  readonly callbacks: Map<
    string,
    (result: {
      observe(value: number, attributes?: Record<string, string>): void;
    }) => void
  >;
  readonly measurements: Map<string, Measurement[]>;
  readonly meter: Meter;
} {
  const callbacks = new Map<
    string,
    (result: {
      observe(value: number, attributes?: Record<string, string>): void;
    }) => void
  >();
  const measurements = new Map<string, Measurement[]>();
  const meter = {
    createHistogram(name: string) {
      return {
        record(value: number, attributes?: Record<string, string>) {
          const values = measurements.get(name) ?? [];
          values.push({
            value,
            ...(attributes === undefined ? {} : { attributes }),
          });
          measurements.set(name, values);
        },
      };
    },
    createObservableGauge(name: string) {
      return {
        addCallback(
          callback: (result: {
            observe(value: number, attributes?: Record<string, string>): void;
          }) => void,
        ) {
          callbacks.set(name, callback);
        },
      };
    },
  } as unknown as Meter;
  return { callbacks, measurements, meter };
}

export function observableMeasurements(
  callbacks: Map<
    string,
    (result: {
      observe(value: number, attributes?: Record<string, string>): void;
    }) => void
  >,
  name: string,
): Measurement[] {
  const observed: Measurement[] = [];
  callbacks.get(name)?.({
    observe: (value, attributes) => {
      observed.push({
        value,
        ...(attributes === undefined ? {} : { attributes }),
      });
    },
  });
  return observed;
}

export function poolAt(index: number): InstanceType<typeof pg.FakePool> {
  const pool = pg.FakePool.instances[index];
  if (pool === undefined)
    throw new Error(`Fake pool ${String(index)} is missing`);
  return pool;
}

type ClientQueryOutcome =
  | Readonly<{
      kind: 'callback';
      error?: Error;
      receiver?: object;
      result?: unknown;
      returned?: unknown;
    }>
  | Readonly<{ kind: 'reject'; error: unknown }>
  | Readonly<{ kind: 'resolve'; result: unknown }>
  | Readonly<{ kind: 'throw'; error: unknown }>;

export function telemetryClient(outcomes: ClientQueryOutcome[]) {
  const listeners = new Map<string, ((value?: unknown) => void)[]>();
  const release = vi.fn();
  const query = vi.fn((...args: unknown[]): unknown => {
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error('query outcome is missing');
    if (outcome.kind === 'throw') {
      // Preserve arbitrary synchronous adapter behavior through instrumentation.
      throw outcome.error;
    }
    if (outcome.kind === 'reject') {
      // Preserve arbitrary asynchronous adapter behavior through instrumentation.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(outcome.error);
    }
    if (outcome.kind === 'resolve') return Promise.resolve(outcome.result);
    const callback = args.at(-1) as (
      this: unknown,
      error: Error | undefined,
      result: unknown,
    ) => unknown;
    callback.call(outcome.receiver, outcome.error, outcome.result);
    return outcome.returned;
  });
  const client = {
    emit(event: string, value?: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    on: vi.fn(),
    once(event: string, listener: (value?: unknown) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return client;
    },
    query,
    release,
  };
  return { client, query, release };
}

export function beforeEachFixture1() {
  pg.FakePool.instances.length = 0;
  pg.FakePool.connectOutcomes.length = 0;
  pg.FakePool.endFailures.length = 0;
  pg.FakePool.queryErrors.length = 0;
  pg.FakePool.queryResults.length = 0;
  pg.FakePool.queryOutcomes.length = 0;
}

export { pg };
