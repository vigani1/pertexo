import { ShutdownCoordinator } from '@pertexo/observability';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

import { WorkerDrainState } from './drain-state.js';

@Injectable()
export class WorkerShutdownCoordinator
  extends ShutdownCoordinator
  implements OnApplicationShutdown
{
  public constructor(drainState: WorkerDrainState) {
    super({
      name: 'Worker',
      beginDrain: () => {
        drainState.beginDrain();
      },
    });
  }
}
