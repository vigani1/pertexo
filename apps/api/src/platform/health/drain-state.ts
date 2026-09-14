import { Global, Injectable, Module } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';

@Injectable()
export class ApiDrainState implements BeforeApplicationShutdown {
  private draining = false;
  private readonly streams = new Set<AbortController>();

  public isDraining(): boolean {
    return this.draining;
  }

  public beginDrain(): void {
    this.draining = true;
    for (const stream of this.streams) stream.abort();
  }

  public registerStream(stream: AbortController): () => void {
    this.streams.add(stream);
    if (this.draining) stream.abort();
    return () => {
      this.streams.delete(stream);
    };
  }

  public activeStreamCount(): number {
    return this.streams.size;
  }

  public beforeApplicationShutdown(): void {
    this.beginDrain();
  }
}

type ShutdownOwner = Readonly<{
  close: () => unknown;
  label: string;
}>;

@Injectable()
export class ApiShutdownCoordinator implements OnApplicationShutdown {
  private readonly owners: ShutdownOwner[] = [];
  private closePromise: Promise<void> | undefined;
  private failure: AggregateError | undefined;

  public constructor(private readonly drainState: ApiDrainState) {}

  public register(label: string, close: () => unknown): void {
    if (this.closePromise !== undefined)
      throw new Error('API shutdown ownership is already closed');
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
    // Explicit application.close() must be allowed to finish Nest's supported
    // listener cleanup before the public wrapper surfaces resource failures.
    // Signal shutdown has no caller, so retain Nest's non-zero exit contract.
    if (signal !== undefined) this.throwIfFailed();
  }

  private async performClose(): Promise<void> {
    this.drainState.beginDrain();
    const failures: unknown[] = [];
    for (const owner of [...this.owners].reverse())
      await Promise.resolve()
        .then(owner.close)
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 0)
      this.failure = new AggregateError(
        failures,
        'API resource shutdown failed',
      );
  }
}

@Global()
@Module({
  providers: [ApiDrainState, ApiShutdownCoordinator],
  exports: [ApiDrainState, ApiShutdownCoordinator],
})
// Nest requires a class as the module container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ApiLifecycleModule {}
