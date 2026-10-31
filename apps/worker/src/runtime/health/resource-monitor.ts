import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerDrainState } from '../shutdown/drain-state.js';

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
  private eventLoopDelayed = false;
  private lastSampledAt: number | undefined;
  private drainStarted = false;
  private stopped = false;
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
    if (this.stopped || this.timer !== undefined) return;
    this.eventLoopDelay.enable();
    // From here, not the first sample: a worker can stop before it has taken one.
    this.lastSampledAt = performance.now();
    this.timer = setInterval(() => {
      this.sample();
    }, this.config.sampleIntervalMillis);
    this.timer.unref();
  }

  public beforeApplicationShutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.eventLoopDelay.disable();
  }

  public sample(): void {
    if (this.drainStarted || this.stopped) return;
    const sample = this.sampleResourceUsage();
    this.eventLoopDelay.reset();
    this.reportEventLoopDelay(sample, this.lateBy());
    // Only memory ends the process: it will die anyway, and draining first is
    // the better way to go. A slow event loop is a busy machine, and a restart
    // would cost its in-flight steps without making the machine less busy.
    this.consecutiveUnhealthySamples =
      sample.rssBytes > this.config.maximumRssBytes
        ? this.consecutiveUnhealthySamples + 1
        : 0;
    if (
      this.consecutiveUnhealthySamples < this.config.unhealthySamplesBeforeDrain
    )
      return;

    this.drainStarted = true;
    this.drainState.beginDrain();
    try {
      this.logger.warn('worker.resource_unhealthy_drain', {
        eventLoopDelayP99Millis: sample.eventLoopDelayP99Millis,
        rssBytes: sample.rssBytes,
      });
    } catch {
      // Diagnostics cannot prevent the required shutdown signal.
    }
    try {
      this.signal();
    } catch (error: unknown) {
      try {
        this.logger.error('worker.resource_shutdown_signal_failed', {}, error);
      } catch {
        // A secondary diagnostic failure cannot escape the interval callback.
      }
    }
  }

  /**
   * How late this sample's own timer fired. A long stall is one reading among a
   * window's hundreds, so a percentile never shows it; the gap always does.
   */
  private lateBy(): number {
    const now = performance.now();
    const previous = this.lastSampledAt;
    this.lastSampledAt = now;
    return previous === undefined
      ? 0
      : Math.max(0, now - previous - this.config.sampleIntervalMillis);
  }

  private reportEventLoopDelay(
    sample: WorkerResourceSample,
    sampleLateByMillis: number,
  ): void {
    const delayed =
      Math.max(sample.eventLoopDelayP99Millis, sampleLateByMillis) >
      this.config.maximumEventLoopDelayMillis;
    if (delayed && !this.eventLoopDelayed)
      try {
        this.logger.warn('worker.event_loop_delayed', {
          eventLoopDelayP99Millis: sample.eventLoopDelayP99Millis,
          ...(sampleLateByMillis > 0 ? { sampleLateByMillis } : {}),
        });
      } catch {
        // Diagnostics cannot change the worker's health decision.
      }
    this.eventLoopDelayed = delayed;
  }
}
