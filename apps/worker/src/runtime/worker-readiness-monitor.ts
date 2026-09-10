import { rm, writeFile } from 'node:fs/promises';

import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { StructuredLogger } from '@pertexo/observability';

const readinessMarker = '/tmp/pertexo-worker-ready';
const readinessRevocationMarker = '/tmp/pertexo-worker-not-ready';

interface WorkerReadinessProbe {
  checkReadiness(): Promise<void>;
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
  ) {}

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
    const check = this.runCheck().finally(() => {
      if (this.currentCheck === check) this.currentCheck = undefined;
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

  private async runCheck(): Promise<void> {
    try {
      await this.readiness.checkReadiness();
      if (this.state === 'checking') await this.marker.setReady(true);
    } catch (error: unknown) {
      this.logger.warn('worker.readiness_check_failed', {}, error);
      try {
        await this.marker.setReady(false);
      } catch (markerError: unknown) {
        this.logger.error(
          'worker.readiness_revocation_failed',
          { phase: 'check' },
          markerError,
        );
        this.failClosed('check', markerError);
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
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;

    try {
      await this.currentCheck;
    } catch {
      // A failed readiness check has already removed the marker and logged.
    }
    try {
      await this.marker.setReady(false);
    } catch (error: unknown) {
      this.logger.error(
        'worker.readiness_revocation_failed',
        { phase: 'shutdown' },
        error,
      );
      this.failClosed('shutdown', error);
    } finally {
      this.state = 'stopped';
    }
  }
}
