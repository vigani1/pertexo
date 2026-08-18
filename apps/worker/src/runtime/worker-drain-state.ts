import { Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';

@Injectable()
export class WorkerDrainState implements BeforeApplicationShutdown {
  private acceptingWork = true;

  public canAcceptWork(): boolean {
    return this.acceptingWork;
  }

  public beginDrain(): void {
    this.acceptingWork = false;
  }

  public beforeApplicationShutdown(): void {
    this.beginDrain();
  }
}
