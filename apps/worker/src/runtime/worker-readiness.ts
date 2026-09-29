import { Inject, Injectable, Optional } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/execution';
import {
  AUTHENTICATION_MAIL_RUNTIME,
  type AuthenticationMailRuntime,
} from '../execution/authentication-mail-runtime.js';

import {
  WORKSPACE_INBOX_RUNTIME,
  type WorkspaceInboxRuntime,
} from '../execution/workspace-inbox-runtime.js';
import { WORKSPACE_DATABASE } from '../platform/database/database.module.js';
import {
  COORDINATOR_RUNTIME,
  OUTBOX_DISPATCHER,
  MAINTENANCE_RUNTIME,
} from '../transport/transport.module.js';
import { NODE_ATTEMPT_RUNTIME } from '../transport/transport.module.js';
import { TRIGGER_RUNTIME } from '../transport/transport.module.js';
import type { TriggerRuntime } from '../triggers/trigger-runtime.js';
import type { OutboxDispatcher } from '../transport/outbox-dispatcher.js';
import type { NodeAttemptRuntime } from '../execution/node-attempt-runtime.js';
import type { CoordinatorRuntime } from '../execution/coordinator-runtime.js';
import type { MaintenanceRuntime } from '../maintenance/runtime.js';
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
    @Inject(MAINTENANCE_RUNTIME)
    private readonly maintenanceRuntime: MaintenanceRuntime | undefined,
    @Optional()
    @Inject(AUTHENTICATION_MAIL_RUNTIME)
    private readonly authenticationMailRuntime?: AuthenticationMailRuntime,
    @Optional()
    @Inject(WORKSPACE_INBOX_RUNTIME)
    private readonly workspaceInboxRuntime?: WorkspaceInboxRuntime,
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
      this.maintenanceRuntime?.checkReadiness(),
      this.workspaceInboxRuntime?.checkReadiness(),
    ]);
    this.authenticationMailRuntime?.checkReadiness();
    this.assertCanAcceptWork();
  }
}
