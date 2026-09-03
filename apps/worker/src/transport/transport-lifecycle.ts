import type {
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import type { CoordinatorRuntime } from '../execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from '../execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from '../execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../runtime/worker-drain-state.js';
import type { TriggerRuntime } from '../triggers/trigger-runtime.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import {
  COORDINATOR_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  PREVIEW_MAINTENANCE_RUNTIME,
  TRIGGER_RUNTIME,
} from './transport-tokens.js';

@Injectable()
export class OutboxDispatcherLifecycle
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  public constructor(
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher,
    @Inject(COORDINATOR_RUNTIME)
    private readonly coordinatorRuntime: CoordinatorRuntime | undefined,
    @Inject(NODE_ATTEMPT_RUNTIME)
    private readonly nodeAttemptRuntime: NodeAttemptRuntime | undefined,
    @Inject(PREVIEW_MAINTENANCE_RUNTIME)
    private readonly previewMaintenanceRuntime:
      PreviewMaintenanceRuntime | undefined,
    @Inject(TRIGGER_RUNTIME)
    private readonly triggerRuntime: TriggerRuntime | undefined,
    private readonly drainState: WorkerDrainState,
  ) {}

  public beforeApplicationShutdown(): void {
    this.drainState.beginDrain();
  }

  public async onApplicationShutdown(): Promise<void> {
    const results = await Promise.allSettled([
      this.dispatcher.close(),
      ...(this.coordinatorRuntime === undefined
        ? []
        : [this.coordinatorRuntime.close()]),
      ...(this.nodeAttemptRuntime === undefined
        ? []
        : [this.nodeAttemptRuntime.close()]),
      ...(this.previewMaintenanceRuntime === undefined
        ? []
        : [this.previewMaintenanceRuntime.close()]),
      ...(this.triggerRuntime === undefined
        ? []
        : [this.triggerRuntime.close()]),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
