import { Global, Injectable, Module } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';

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

@Global()
@Module({ providers: [ApiDrainState], exports: [ApiDrainState] })
// Nest requires a class as the module container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ApiLifecycleModule {}
