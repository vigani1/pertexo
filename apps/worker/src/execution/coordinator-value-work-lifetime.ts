import type {
  NativeCoordinatorValueOwner,
  InspectCoordinatorValueReadOwner,
} from '@pertexo/database/execution';
import {
  callableValueWorkStopSchema,
  type CallableValueWorkStop,
} from '@pertexo/workflow-model/workflow-call-contract';
import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';
import { z } from 'zod';
import { CallableCompletionStoppedError } from '@pertexo/workflow-engine';

export type CoordinatorValueWorkOwner = NativeCoordinatorValueOwner;

export type CoordinatorValueWorkPolicy = Readonly<{
  controlPollMillis: number;
  controlReadTimeoutMillis: number;
  operationTimeoutMillis: number;
}>;

/** For the existing worker configuration owner; no environment is read here. */
export const COORDINATOR_VALUE_WORK_POLICY_DEFAULTS = Object.freeze({
  controlPollMillis: 250,
  controlReadTimeoutMillis: 2_000,
  operationTimeoutMillis: 30_000,
});

const ownerInspectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('active'),
      databaseNow: z.string(),
      deadlineAt: z.string().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal('stopped'), stop: callableValueWorkStopSchema })
    .strict(),
]);

/** Must dispose/cancel and settle on abort; typed stops classify known outages only. */
export type InspectCoordinatorValueOwner = InspectCoordinatorValueReadOwner;

export type CoordinatorValueWorkSession = Readonly<{
  /** Callback-scoped cancellation only; never a source or acceptance grant. */
  signal: AbortSignal;
  perform<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
}>;

export type CoordinatorValueWorkResult<T> =
  | Readonly<{ kind: 'completed'; value: T }>
  | Readonly<{ kind: 'stopped'; stop: CallableValueWorkStop }>;

class ValueWorkStopped extends Error {
  public constructor(readonly stop: CallableValueWorkStop) {
    super(`Coordinator value scope stopped: ${stop.kind}`);
  }
}

type LifetimeDependencies = Readonly<{
  policy: CoordinatorValueWorkPolicy;
  inspectOwner?: InspectCoordinatorValueOwner;
}>;

class CoordinatorValueScope {
  private closed = false;
  private readonly executionAbort = new AbortController();
  private readonly watcherStop = new AbortController();
  private stopped: CallableValueWorkStop | undefined;
  private failure: { error: unknown } | undefined;
  private watcher: Promise<void> | undefined;
  private checks: Promise<void> = Promise.resolve();
  private operationDeadline: number | undefined;
  private executionDeadline = Number.POSITIVE_INFINITY;
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineConfirmation: Promise<void> | undefined;
  private readonly workTasks = new Set<Promise<unknown>>();
  private readonly onContextAbort = (): void => {
    this.stop({ kind: 'context_aborted' });
  };
  public constructor(
    private readonly dependencies: LifetimeDependencies,
    private readonly owner: CoordinatorValueWorkOwner,
    private readonly contextSignal: AbortSignal,
  ) {
    contextSignal.addEventListener('abort', this.onContextAbort, {
      once: true,
    });
    if (contextSignal.aborted) this.onContextAbort();
  }

  private stop(stop: CallableValueWorkStop, confirm = false): void {
    if (
      confirm &&
      this.stopped?.kind === 'unavailable' &&
      this.stopped.reason === 'value_work_timeout'
    )
      this.stopped = Object.freeze({ ...stop });
    else this.stopped ??= Object.freeze({ ...stop });
    this.executionAbort.abort(new ValueWorkStopped(this.stopped));
  }

  private assertRunning(): void {
    if (this.failure !== undefined) throw this.failure.error;
    if (this.stopped !== undefined) throw new ValueWorkStopped(this.stopped);
  }

  private initializeBudget(): void {
    if (this.operationDeadline !== undefined) return;
    this.operationDeadline =
      performance.now() + this.dependencies.policy.operationTimeoutMillis;
    this.armBudget();
  }

  private expireBudget(): void {
    this.stop({ kind: 'unavailable', reason: 'value_work_timeout' });
    if (
      this.executionDeadline <
        (this.operationDeadline ?? Number.POSITIVE_INFINITY) &&
      this.deadlineConfirmation === undefined
    )
      this.deadlineConfirmation = this.inspect(true).catch((error: unknown) => {
        if (!(error instanceof ValueWorkStopped)) {
          this.failure ??= { error };
          this.executionAbort.abort(error);
        }
      });
  }

  private armBudget(): void {
    clearTimeout(this.budgetTimer);
    const remaining =
      Math.min(
        this.operationDeadline ?? Number.POSITIVE_INFINITY,
        this.executionDeadline,
      ) - performance.now();
    this.budgetTimer = setTimeout(
      () => {
        this.expireBudget();
      },
      Math.max(0, remaining),
    );
  }

  private readTimeoutMillis(confirmation: boolean): number {
    if (confirmation) {
      // Classification is a bounded control read, not further value work. Local
      // elapsed time cannot mint a durable timed_out fact; only this owner can.
      const remaining =
        (this.operationDeadline ?? Number.POSITIVE_INFINITY) -
        performance.now();
      return Math.min(
        this.dependencies.policy.controlReadTimeoutMillis,
        remaining > 0
          ? remaining
          : this.dependencies.policy.controlReadTimeoutMillis,
      );
    }
    const remaining =
      Math.min(
        this.operationDeadline ?? Number.POSITIVE_INFINITY,
        this.executionDeadline,
      ) - performance.now();
    if (remaining <= 0) this.expireBudget();
    this.assertRunning();
    return Math.min(
      this.dependencies.policy.controlReadTimeoutMillis,
      remaining,
    );
  }

  private async inspect(confirmation = false): Promise<void> {
    const check = this.checks.then(() => this.readOwner(confirmation));
    // Keep ownership of the serial chain; the caller still observes any error.
    this.checks = check.then(
      () => undefined,
      () => undefined,
    );
    await check;
  }

  private async readOwner(confirmation: boolean): Promise<void> {
    if (!confirmation || this.contextSignal.aborted) this.assertRunning();
    const read = this.dependencies.inspectOwner;
    if (read === undefined)
      throw new ValueWorkStopped({
        kind: 'unavailable',
        reason: 'control_read_failed',
      });
    const started = performance.now();
    const readTimeoutMillis = this.readTimeoutMillis(confirmation);
    const readAbort = new AbortController();
    const timeout = setTimeout(() => {
      const stop: CallableValueWorkStop = {
        kind: 'unavailable',
        reason: 'control_read_failed',
      };
      this.stop(stop, confirmation);
      readAbort.abort(new ValueWorkStopped(this.stopped ?? stop));
    }, readTimeoutMillis);
    try {
      const reply = await read({
        owner: structuredClone(this.owner),
        signal: AbortSignal.any([
          confirmation ? this.contextSignal : this.executionAbort.signal,
          this.watcherStop.signal,
          readAbort.signal,
        ]),
        readTimeoutMillis,
      });
      const parsed = ownerInspectionSchema.safeParse(reply);
      if (!parsed.success)
        throw new TypeError('Coordinator owner inspection is invalid');
      const result = parsed.data;
      if (result.kind === 'stopped') {
        this.stop(result.stop, confirmation);
      } else {
        const databaseNow = Date.parse(result.databaseNow);
        const deadlineAt =
          result.deadlineAt === null
            ? Number.POSITIVE_INFINITY
            : Date.parse(result.deadlineAt);
        if (!Number.isFinite(databaseNow) || Number.isNaN(deadlineAt))
          throw new TypeError('Coordinator owner deadline metadata is invalid');
        if (!confirmation) {
          // Conservative read-start reference includes checkout/query latency.
          this.executionDeadline = Math.min(
            this.executionDeadline,
            started + deadlineAt - databaseNow,
          );
          if (this.executionDeadline <= performance.now()) this.expireBudget();
          else this.armBudget();
        }
      }
      if (!confirmation) this.assertRunning();
    } catch (error: unknown) {
      if (
        this.executionAbort.signal.aborted &&
        error instanceof Error &&
        (error === this.executionAbort.signal.reason ||
          error.name === 'AbortError')
      )
        this.assertRunning();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async watch(): Promise<void> {
    try {
      const signal = AbortSignal.any([
        this.executionAbort.signal,
        this.watcherStop.signal,
      ]);
      while (this.watcherActive()) {
        await waitForSupervisorDelay(
          this.dependencies.policy.controlPollMillis,
          signal,
        );
        if (this.watcherActive()) await this.inspect();
      }
    } catch (error: unknown) {
      const expectedAbort =
        error instanceof Error &&
        (error === this.watcherStop.signal.reason ||
          error.name === 'AbortError');
      if (
        !(error instanceof ValueWorkStopped) &&
        !(this.watcherStop.signal.aborted && expectedAbort)
      ) {
        this.failure ??= { error };
        this.executionAbort.abort(error);
      }
    }
  }

  private watcherActive(): boolean {
    return (
      !this.executionAbort.signal.aborted && !this.watcherStop.signal.aborted
    );
  }

  private async perform<T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new TypeError('Coordinator value session is closed');
    this.initializeBudget();
    await this.inspect();
    this.watcher ??= this.watch();
    let value: T;
    try {
      value = await work(this.executionAbort.signal);
    } catch (error: unknown) {
      if (error instanceof CallableCompletionStoppedError)
        throw new ValueWorkStopped(error.stop);
      if (
        this.executionAbort.signal.aborted &&
        error instanceof Error &&
        (error === this.executionAbort.signal.reason ||
          error.name === 'AbortError')
      )
        this.assertRunning();
      throw error;
    }
    await this.inspect();
    return value;
  }

  private track<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new TypeError('Coordinator value session is closed'),
      );
    const task = this.perform(work);
    this.workTasks.add(task);
    void task.then(
      () => this.workTasks.delete(task),
      (error: unknown) => {
        this.workTasks.delete(task);
        if (error instanceof ValueWorkStopped) this.stop(error.stop);
        else {
          this.failure ??= { error };
          this.executionAbort.abort(error);
        }
      },
    );
    return task;
  }

  public async run<T>(
    work: (session: CoordinatorValueWorkSession) => Promise<T>,
  ): Promise<CoordinatorValueWorkResult<T>> {
    let outcome: { value: T } | { error: unknown };
    try {
      this.assertRunning();
      const value = await work(
        Object.freeze({
          signal: this.executionAbort.signal,
          perform: <U>(operation: (signal: AbortSignal) => Promise<U>) =>
            this.track(operation),
        }),
      );
      this.assertRunning();
      outcome = { value };
    } catch (error: unknown) {
      outcome = { error };
      if (!(error instanceof ValueWorkStopped)) {
        this.failure ??= { error };
        this.executionAbort.abort(error);
      }
    } finally {
      this.closed = true;
      await Promise.allSettled([...this.workTasks]);
      clearTimeout(this.budgetTimer);
      await this.deadlineConfirmation;
      this.watcherStop.abort();
      this.executionAbort.abort();
      await this.watcher;
      await this.deadlineConfirmation;
      await this.checks;
      this.contextSignal.removeEventListener('abort', this.onContextAbort);
    }
    if ('error' in outcome && !(outcome.error instanceof ValueWorkStopped))
      throw outcome.error;
    if (this.failure !== undefined) throw this.failure.error;
    if (this.stopped !== undefined)
      return { kind: 'stopped', stop: this.stopped };
    if ('error' in outcome && outcome.error instanceof ValueWorkStopped)
      return { kind: 'stopped', stop: outcome.error.stop };
    if ('value' in outcome) return { kind: 'completed', value: outcome.value };
    throw new TypeError('Coordinator value scope outcome is invalid');
  }
}

/** Framework-only borrowed adapters, not source/receipt or accepted-result proof. */
export function createCoordinatorValueWorkLifetime(
  dependencies: LifetimeDependencies,
) {
  const policy = Object.freeze({ ...dependencies.policy });
  for (const [field, minimum, maximum] of [
    ['controlPollMillis', 100, 1_000],
    ['controlReadTimeoutMillis', 100, 5_000],
    ['operationTimeoutMillis', 1_000, 60_000],
  ] as const) {
    if (
      !Number.isSafeInteger(policy[field]) ||
      policy[field] < minimum ||
      policy[field] > maximum
    )
      throw new TypeError(`Coordinator value policy ${field} is invalid`);
  }
  const borrowed = Object.freeze({
    policy,
    ...(dependencies.inspectOwner === undefined
      ? {}
      : { inspectOwner: dependencies.inspectOwner }),
  });
  return Object.freeze({
    withValueWork: async <T>(
      owner: CoordinatorValueWorkOwner,
      signal: AbortSignal,
      work: (session: CoordinatorValueWorkSession) => Promise<T>,
    ): Promise<CoordinatorValueWorkResult<T>> => {
      return await new CoordinatorValueScope(
        borrowed,
        structuredClone(owner),
        signal,
      ).run(work);
    },
  });
}
