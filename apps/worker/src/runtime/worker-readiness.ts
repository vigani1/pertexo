import { Inject, Injectable, Optional } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/execution';
import {
  AUTHENTICATION_MAIL_RUNTIME,
  type AuthenticationMailRuntime,
} from '../execution/authentication-mail-runtime.js';

import { WORKSPACE_DATABASE } from '../platform/database/database.module.js';
import {
  COORDINATOR_RUNTIME,
  OUTBOX_DISPATCHER,
  PREVIEW_MAINTENANCE_RUNTIME,
} from '../transport/transport.module.js';
import { NODE_ATTEMPT_RUNTIME } from '../transport/transport.module.js';
import { TRIGGER_RUNTIME } from '../transport/transport.module.js';
import type { TriggerRuntime } from '../triggers/trigger-runtime.js';
import type { OutboxDispatcher } from '../transport/outbox-dispatcher.js';
import type { NodeAttemptRuntime } from '../execution/node-attempt-runtime.js';
import type { CoordinatorRuntime } from '../execution/coordinator-runtime.js';
import type { PreviewMaintenanceRuntime } from '../execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from './worker-drain-state.js';

class WorkerDrainingError extends Error {
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
    @Optional()
    @Inject(TRIGGER_RUNTIME)
    private readonly triggerRuntime: TriggerRuntime | undefined,
    @Optional()
    @Inject(NODE_ATTEMPT_RUNTIME)
    private readonly nodeAttemptRuntime: NodeAttemptRuntime | undefined,
    @Optional()
    @Inject(COORDINATOR_RUNTIME)
    private readonly coordinatorRuntime: CoordinatorRuntime | undefined,
    @Optional()
    @Inject(PREVIEW_MAINTENANCE_RUNTIME)
    private readonly previewMaintenanceRuntime:
      PreviewMaintenanceRuntime | undefined,
    @Optional()
    @Inject(AUTHENTICATION_MAIL_RUNTIME)
    private readonly authenticationMailRuntime?: AuthenticationMailRuntime,
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
      this.triggerRuntime?.checkReadiness(),
      this.nodeAttemptRuntime?.checkReadiness?.(),
      this.coordinatorRuntime?.checkReadiness(),
      this.previewMaintenanceRuntime?.checkReadiness(),
    ]);
    this.authenticationMailRuntime?.checkReadiness();
    this.assertCanAcceptWork();
  }
}
