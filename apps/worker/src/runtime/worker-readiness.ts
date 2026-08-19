import { Inject, Injectable } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database';

import { WORKSPACE_DATABASE } from '../platform/database/database.module.js';
import { OUTBOX_DISPATCHER } from '../transport/transport.module.js';
import type { OutboxDispatcher } from '../transport/outbox-dispatcher.js';
import { WorkerDrainState } from './worker-drain-state.js';

export class WorkerDrainingError extends Error {
  public constructor() {
    super('worker is draining and cannot accept new work');
    this.name = 'WorkerDrainingError';
  }
}

@Injectable()
export class WorkerReadiness {
  public constructor(
    @Inject(WORKSPACE_DATABASE)
    private readonly database: WorkspaceDatabase,
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher,
    private readonly drainState: WorkerDrainState,
  ) {}

  public assertCanAcceptWork(): void {
    if (!this.drainState.canAcceptWork()) {
      throw new WorkerDrainingError();
    }
  }

  public async checkReadiness(): Promise<void> {
    this.assertCanAcceptWork();
    await Promise.all([
      this.database.checkReadiness(),
      this.dispatcher.checkReadiness(),
    ]);
  }
}
