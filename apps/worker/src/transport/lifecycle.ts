import { Inject, Injectable } from '@nestjs/common';

import type { CoordinatorRuntime } from '../runs/runtime.js';
import type { NodeAttemptRuntime } from '../attempts/runtime.js';
import type { MaintenanceRuntime } from '../maintenance/runtime.js';
import { WorkerDrainState } from '../runtime/drain-state.js';
import type { TriggerRuntime } from '../triggers/runtime.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import {
  COORDINATOR_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  MAINTENANCE_RUNTIME,
  TRIGGER_RUNTIME,
} from './tokens.js';

@Injectable()
export class OutboxDispatcherLifecycle {
  private shutdownPromise: Promise<void> | undefined;

  public constructor(
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher,
    @Inject(COORDINATOR_RUNTIME)
    private readonly coordinatorRuntime: CoordinatorRuntime | undefined,
    @Inject(NODE_ATTEMPT_RUNTIME)
    private readonly nodeAttemptRuntime: NodeAttemptRuntime | undefined,
    @Inject(MAINTENANCE_RUNTIME)
    private readonly maintenanceRuntime: MaintenanceRuntime | undefined,
    @Inject(TRIGGER_RUNTIME)
    private readonly triggerRuntime: TriggerRuntime | undefined,
    private readonly drainState: WorkerDrainState,
  ) {}

  public beginDrain(): void {
    this.drainState.beginDrain();
  }

  public close(): Promise<void> {
    this.beginDrain();
    this.shutdownPromise ??= this.closeOwnedResources();
    return this.shutdownPromise;
  }

  private async closeOwnedResources(): Promise<void> {
    const dispatcherResult = await Promise.allSettled([
      Promise.resolve().then(() => this.dispatcher.close()),
    ]);
    const runtimeResults = await Promise.allSettled([
      ...(this.coordinatorRuntime === undefined
        ? []
        : [Promise.resolve().then(() => this.coordinatorRuntime?.close())]),
      ...(this.nodeAttemptRuntime === undefined
        ? []
        : [Promise.resolve().then(() => this.nodeAttemptRuntime?.close())]),
      ...(this.maintenanceRuntime === undefined
        ? []
        : [Promise.resolve().then(() => this.maintenanceRuntime?.close())]),
      ...(this.triggerRuntime === undefined
        ? []
        : [Promise.resolve().then(() => this.triggerRuntime?.close())]),
    ]);
    const failures = [...dispatcherResult, ...runtimeResults].flatMap(
      (result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, 'Worker transport shutdown failed');
  }
}
