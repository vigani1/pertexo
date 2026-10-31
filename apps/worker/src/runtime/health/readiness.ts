import { Inject, Injectable, Optional } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import {
  SYSTEM_MAIL_RUNTIME,
  type SystemMailRuntime,
} from '../../mail/runtime.js';

import {
  WORKSPACE_INBOX_RUNTIME,
  type WorkspaceInboxRuntime,
} from '../../notifications/inbox-runtime.js';
import {
  WORKFLOW_AUTO_PAUSE_RUNTIME,
  type WorkflowAutoPauseRuntime,
} from '../../workflows/auto-pause-runtime.js';
import { WORKSPACE_DATABASE } from '../../platform/database/module.js';
import {
  COORDINATOR_RUNTIME,
  MAINTENANCE_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  TRIGGER_RUNTIME,
} from '../../transport/module.js';
import type { TriggerRuntime } from '../../triggers/runtime.js';
import type { OutboxDispatcher } from '../../transport/outbox/dispatch/runtime.js';
import type { NodeAttemptRuntime } from '../../attempts/delivery/runtime.js';
import type { CoordinatorRuntime } from '../../runs/runtime.js';
import type { MaintenanceRuntime } from '../../maintenance/runtime.js';
import { WorkerDrainState } from '../shutdown/drain-state.js';

class WorkerDrainingError extends Error {
  public constructor() {
    super('worker is draining and cannot accept new work');
    this.name = 'WorkerDrainingError';
  }
}

@Injectable()
export class WorkerReadiness {
  // Nest resolves these dependencies positionally; grouping them would change DI.
  // eslint-disable-next-line max-params
  public constructor(
    @Inject(WORKSPACE_DATABASE)
    private readonly database: WorkspaceDatabase,
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher,
    private readonly drainState: WorkerDrainState,
    @Inject(TRIGGER_RUNTIME)
    private readonly triggerRuntime: TriggerRuntime,
    @Inject(NODE_ATTEMPT_RUNTIME)
    private readonly nodeAttemptRuntime: NodeAttemptRuntime,
    @Inject(COORDINATOR_RUNTIME)
    private readonly coordinatorRuntime: CoordinatorRuntime,
    @Inject(MAINTENANCE_RUNTIME)
    private readonly maintenanceRuntime: MaintenanceRuntime,
    @Inject(WORKSPACE_INBOX_RUNTIME)
    private readonly workspaceInboxRuntime: WorkspaceInboxRuntime,
    @Inject(WORKFLOW_AUTO_PAUSE_RUNTIME)
    private readonly workflowAutoPauseRuntime: WorkflowAutoPauseRuntime,
    // Absent until authentication mail is configured.
    @Optional()
    @Inject(SYSTEM_MAIL_RUNTIME)
    private readonly authenticationMailRuntime?: SystemMailRuntime,
  ) {}

  public assertCanAcceptWork(): void {
    if (!this.drainState.canAcceptWork()) {
      throw new WorkerDrainingError();
    }
  }

  /** Files fail on their own and everything else keeps running, so this only reports. */
  public checkObjectStore(): Promise<void> {
    return this.nodeAttemptRuntime.checkObjectStore();
  }

  public async checkReadiness(): Promise<void> {
    this.assertCanAcceptWork();
    await Promise.all([
      this.database.checkReadiness(),
      this.dispatcher.checkReadiness(),
      this.triggerRuntime.checkReadiness(),
      this.nodeAttemptRuntime.checkReadiness(),
      this.coordinatorRuntime.checkReadiness(),
      this.maintenanceRuntime.checkReadiness(),
      this.workspaceInboxRuntime.checkReadiness(),
      this.workflowAutoPauseRuntime.checkReadiness(),
      this.authenticationMailRuntime?.checkReadiness(),
    ]);
    this.assertCanAcceptWork();
  }
}
