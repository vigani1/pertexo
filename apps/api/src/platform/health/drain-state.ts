import { Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';

@Injectable()
export class ApiDrainState implements BeforeApplicationShutdown {
  private draining = false;

  public isDraining(): boolean {
    return this.draining;
  }

  public beginDrain(): void {
    this.draining = true;
  }

  public beforeApplicationShutdown(): void {
    this.beginDrain();
  }
}
