import { Injectable } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';

const KEEP_ALIVE_INTERVAL_MS = 2_147_483_647;

@Injectable()
export class WorkerProcessKeepalive
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer: NodeJS.Timeout | undefined;

  public onApplicationBootstrap(): void {
    // Enabled consumers own live connections. This lifecycle-owned timer also
    // retains workers whose dispatch capabilities are intentionally disabled.
    this.timer ??= setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
  }

  public beforeApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
