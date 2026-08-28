import { monitorEventLoopDelay } from 'node:perf_hooks';

import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerDrainState } from './worker-drain-state.js';

export type WorkerResourceSafetyConfig = Readonly<{
  maximumEventLoopDelayMillis: number;
  maximumRssBytes: number;
  sampleIntervalMillis: number;
  unhealthySamplesBeforeDrain: number;
}>;

type WorkerResourceSample = Readonly<{
  eventLoopDelayP99Millis: number;
  rssBytes: number;
}>;

type WorkerResourceMonitorDependencies = Readonly<{
  sample?: () => WorkerResourceSample;
  signal?: () => void;
}>;

export class WorkerResourceMonitor
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly sampleResourceUsage: () => WorkerResourceSample;
  private readonly signal: () => void;
  private consecutiveUnhealthySamples = 0;
  private drainStarted = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly config: WorkerResourceSafetyConfig,
    private readonly drainState: WorkerDrainState,
    private readonly logger: StructuredLogger,
    dependencies: WorkerResourceMonitorDependencies = {},
  ) {
    this.sampleResourceUsage =
      dependencies.sample ??
      (() => ({
        eventLoopDelayP99Millis: this.eventLoopDelay.percentile(99) / 1_000_000,
        rssBytes: process.memoryUsage.rss(),
      }));
    this.signal =
      dependencies.signal ??
      (() => {
        process.kill(process.pid, 'SIGTERM');
      });
  }

  public onApplicationBootstrap(): void {
    this.eventLoopDelay.enable();
    this.timer = setInterval(() => {
      this.sample();
    }, this.config.sampleIntervalMillis);
    this.timer.unref();
  }

  public beforeApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.eventLoopDelay.disable();
  }

  public sample(): void {
    if (this.drainStarted) return;
    const sample = this.sampleResourceUsage();
    this.eventLoopDelay.reset();
    const unhealthy =
      sample.rssBytes > this.config.maximumRssBytes ||
      sample.eventLoopDelayP99Millis > this.config.maximumEventLoopDelayMillis;
    this.consecutiveUnhealthySamples = unhealthy
      ? this.consecutiveUnhealthySamples + 1
      : 0;
    if (
      this.consecutiveUnhealthySamples < this.config.unhealthySamplesBeforeDrain
    )
      return;

    this.drainStarted = true;
    this.drainState.beginDrain();
    this.logger.warn('worker.resource_unhealthy_drain', {
      eventLoopDelayP99Millis: sample.eventLoopDelayP99Millis,
      rssBytes: sample.rssBytes,
    });
    this.signal();
  }
}
