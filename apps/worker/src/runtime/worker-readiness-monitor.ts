import { rm, writeFile } from 'node:fs/promises';

import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerReadiness } from './worker-readiness.js';

const readinessMarker = '/tmp/pertexo-worker-ready';

export class WorkerReadinessMonitor
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private checking = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly readiness: WorkerReadiness,
    private readonly logger: StructuredLogger,
  ) {}

  public onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.check().catch(() => undefined);
    }, 10_000);
    this.timer.unref();
  }

  public async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.setReady(false);
  }

  public async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.readiness.checkReadiness();
      await this.setReady(true);
    } catch (error: unknown) {
      await this.setReady(false);
      this.logger.warn('worker.readiness_check_failed', {}, error);
      throw error;
    } finally {
      this.checking = false;
    }
  }

  private async setReady(ready: boolean): Promise<void> {
    if (ready) {
      await writeFile(readinessMarker, '', { mode: 0o600 });
      return;
    }
    await rm(readinessMarker, { force: true });
  }
}
