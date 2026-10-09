import { Inject, Injectable, Optional } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import {
  AUTHENTICATION_MAIL_RUNTIME,
  type AuthenticationMailRuntime,
} from '../../identity/authentication-mail-runtime.js';

import {
  WORKSPACE_INBOX_RUNTIME,
  type WorkspaceInboxRuntime,
} from '../../notifications/inbox-runtime.js';
import {
  WORKFLOW_AUTO_PAUSE_RUNTIME,
  type WorkflowAutoPauseRuntime,
} from '../../workflows/auto-pause-runtime.js';
import { WORKSPACE_DATABASE } from '../../platform/database/database.module.js';
import {
  RETENTION_RUNTIME,
  type RetentionRuntime,
} from '../../retention/runtime.js';
import {
  COORDINATOR_RUNTIME,
  MAINTENANCE_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  TRIGGER_RUNTIME,
} from '../../transport/module.js';
import type { TriggerRuntime } from '../../triggers/runtime.js';
import type { OutboxDispatcher } from '../../transport/outbox/dispatcher.js';
import type { NodeAttemptRuntime } from '../../attempts/runtime.js';
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
    @Inject(RETENTION_RUNTIME)
    private readonly retentionRuntime: RetentionRuntime,
    // Absent until authentication mail is configured.
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
      this.triggerRuntime.checkReadiness(),
      this.nodeAttemptRuntime.checkReadiness(),
      this.coordinatorRuntime.checkReadiness(),
      this.maintenanceRuntime.checkReadiness(),
      this.workspaceInboxRuntime.checkReadiness(),
      this.workflowAutoPauseRuntime.checkReadiness(),
      this.retentionRuntime.checkReadiness(),
      this.authenticationMailRuntime?.checkReadiness(),
    ]);
    this.assertCanAcceptWork();
  }
}
