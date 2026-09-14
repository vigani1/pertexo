import { rm, writeFile } from 'node:fs/promises';

import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { StructuredLogger } from '@pertexo/observability';

import { boundedBackgroundTask } from './background-task-deadline.js';

const readinessMarker = '/tmp/pertexo-worker-ready';
const readinessRevocationMarker = '/tmp/pertexo-worker-not-ready';

interface WorkerReadinessProbe {
  checkReadiness(signal?: AbortSignal): Promise<void>;
}

export interface WorkerReadinessMarker {
  setReady(ready: boolean): Promise<void>;
}

type WorkerReadinessMonitorState = 'idle' | 'checking' | 'stopping' | 'stopped';

const fileReadinessMarker: WorkerReadinessMarker = {
  async setReady(ready: boolean): Promise<void> {
    if (ready) {
      await writeFile(readinessMarker, '', { mode: 0o600 });
      await rm(readinessRevocationMarker, { force: true });
      return;
    }
    const results = await Promise.allSettled([
      writeFile(readinessRevocationMarker, '', { mode: 0o600 }),
      rm(readinessMarker, { force: true }),
    ]);
    const failures: unknown[] = [];
    for (const result of results)
      if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        'Worker readiness marker revocation failed',
      );
  },
};

type ReadinessRevocationPhase = 'check' | 'shutdown';

function markProcessUnhealthy(): void {
  process.exitCode = 1;
}

export class WorkerReadinessMonitor implements BeforeApplicationShutdown {
  private currentCheck: Promise<void> | undefined;
  private currentCheckController: AbortController | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private state: WorkerReadinessMonitorState = 'idle';
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly readiness: WorkerReadinessProbe,
    private readonly logger: StructuredLogger,
    private readonly marker: WorkerReadinessMarker = fileReadinessMarker,
    private readonly failClosed: (
      phase: ReadinessRevocationPhase,
      error: unknown,
    ) => void = markProcessUnhealthy,
    private readonly operationTimeoutMillis = 5_000,
  ) {
    if (
      !Number.isSafeInteger(operationTimeoutMillis) ||
      operationTimeoutMillis < 1 ||
      operationTimeoutMillis > 120_000
    )
      throw new RangeError('Worker readiness timeout is invalid');
  }

  public start(): void {
    if (
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.timer !== undefined
    )
      return;
    this.timer = setInterval(() => {
      void this.check().catch(() => {
        process.exitCode = 1;
        process.kill(process.pid, 'SIGTERM');
      });
    }, 10_000);
    this.timer.unref();
  }

  public beforeApplicationShutdown(): Promise<void> {
    this.shutdownPromise ??= this.stop();
    return this.shutdownPromise;
  }

  public check(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return Promise.resolve();
    }
    if (this.currentCheck !== undefined) return this.currentCheck;

    this.state = 'checking';
    const controller = new AbortController();
    this.currentCheckController = controller;
    const check = this.runCheck(controller.signal).finally(() => {
      if (this.currentCheck === check) this.currentCheck = undefined;
      if (this.currentCheckController === controller)
        this.currentCheckController = undefined;
      if (this.state === 'checking') this.state = 'idle';
    });
    this.currentCheck = check;
    return check;
  }

  public status(): {
    state: WorkerReadinessMonitorState;
    checkInFlight: boolean;
    scheduled: boolean;
  } {
    return {
      state: this.state,
      checkInFlight: this.currentCheck !== undefined,
      scheduled: this.timer !== undefined,
    };
  }

  private async runCheck(signal: AbortSignal): Promise<void> {
    try {
      await boundedBackgroundTask(
        Promise.resolve().then(() => this.readiness.checkReadiness(signal)),
        this.operationTimeoutMillis,
      );
      if (this.state === 'checking') await this.setReady();
    } catch (error: unknown) {
      this.safeLog('warn', 'worker.readiness_check_failed', {}, error);
      try {
        await this.setNotReady();
      } catch (markerError: unknown) {
        this.safeLog(
          'error',
          'worker.readiness_revocation_failed',
          { phase: 'check' },
          markerError,
        );
        this.safeFailClosed('check', markerError);
        throw new AggregateError(
          [error, markerError],
          'Worker readiness check and marker revocation failed',
        );
      }
      throw error;
    }
  }

  private async stop(): Promise<void> {
    this.state = 'stopping';
    this.currentCheckController?.abort(
      new Error('Worker readiness shutdown started'),
    );
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;

    const inFlight = this.currentCheck;
    const cleanup = await Promise.allSettled([
      this.setNotReady(),
      ...(inFlight === undefined
        ? []
        : [boundedBackgroundTask(inFlight, this.operationTimeoutMillis)]),
    ]);
    const revocation = cleanup[0];
    if (revocation.status === 'rejected') {
      this.safeLog(
        'error',
        'worker.readiness_revocation_failed',
        { phase: 'shutdown' },
        revocation.reason,
      );
      this.safeFailClosed('shutdown', revocation.reason);
    }
    const checkCleanup = cleanup[1];
    if (checkCleanup?.status === 'rejected') {
      this.safeLog(
        'error',
        'worker.readiness_cleanup_incomplete',
        { phase: 'shutdown' },
        checkCleanup.reason,
      );
    }
    this.state = 'stopped';
  }

  private async setReady(): Promise<void> {
    const readyWrite = Promise.resolve().then(() => this.marker.setReady(true));
    try {
      await boundedBackgroundTask(readyWrite, this.operationTimeoutMillis);
    } catch (error: unknown) {
      void readyWrite.then(
        () => {
          if (this.state !== 'checking') this.observeLateRevocation();
        },
        () => undefined,
      );
      throw error;
    }
    if (this.state !== 'checking') await this.setNotReady();
  }

  private setNotReady(): Promise<void> {
    return boundedBackgroundTask(
      Promise.resolve().then(() => this.marker.setReady(false)),
      this.operationTimeoutMillis,
    );
  }

  private observeLateRevocation(): void {
    void this.setNotReady().catch((error: unknown) => {
      this.safeLog(
        'error',
        'worker.readiness_revocation_failed',
        { phase: 'shutdown' },
        error,
      );
      this.safeFailClosed('shutdown', error);
    });
  }

  private safeLog(
    level: 'error' | 'warn',
    message: string,
    context: Readonly<Record<string, unknown>>,
    error: unknown,
  ): void {
    try {
      this.logger[level](message, context, error);
    } catch {
      // Diagnostics cannot prevent readiness revocation or replace its cause.
    }
  }

  private safeFailClosed(
    phase: ReadinessRevocationPhase,
    error: unknown,
  ): void {
    try {
      this.failClosed(phase, error);
    } catch {
      markProcessUnhealthy();
    }
  }
}
