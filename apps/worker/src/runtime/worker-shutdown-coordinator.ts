import type { OnApplicationShutdown } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import { WorkerDrainState } from './worker-drain-state.js';

type ShutdownOwner = Readonly<{
  close: () => unknown;
  label: string;
}>;

@Injectable()
export class WorkerShutdownCoordinator implements OnApplicationShutdown {
  private readonly owners: ShutdownOwner[] = [];
  private closePromise: Promise<void> | undefined;
  private failure: AggregateError | undefined;

  public constructor(private readonly drainState: WorkerDrainState) {}

  public register(label: string, close: () => unknown): void {
    if (this.closePromise !== undefined)
      throw new Error('Worker shutdown ownership is already closed');
    this.owners.push({ close, label });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  public throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  public async onApplicationShutdown(signal?: string): Promise<void> {
    await this.close();
    if (signal !== undefined) this.throwIfFailed();
  }

  private async performClose(): Promise<void> {
    this.drainState.beginDrain();
    const failures: unknown[] = [];
    for (const owner of this.owners)
      await Promise.resolve()
        .then(owner.close)
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 0)
      this.failure = new AggregateError(
        failures,
        'Worker resource shutdown failed',
      );
  }
}
