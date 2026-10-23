import { TransportOperationTimeoutError } from '../operation-deadline.js';
import type { OutboxDispatcherRuntimeHooks } from './contract.js';

const WORKSPACE_CAPACITY_SAMPLE_INTERVAL_MILLIS = 5 * 60_000;

const MAX_TRACKED_WORKSPACE_CAPACITY_SAMPLES = 1_000;

const MAX_PENDING_WORKSPACE_CAPACITY_SAMPLES = 100;

async function observeDispatchCapacity(
  hooks: OutboxDispatcherRuntimeHooks | undefined,
  workspaceId: string,
  timeoutMillis: number,
): Promise<void> {
  if (hooks === undefined) return;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TransportOperationTimeoutError(timeoutMillis));
  }, timeoutMillis);
  timer.unref();
  try {
    await hooks.observeWorkspaceCapacity(workspaceId, controller.signal);
  } catch {
    // Capacity telemetry cannot alter durable publication acknowledgement.
  } finally {
    clearTimeout(timer);
  }
}

export class OutboxCapacitySampler {
  private readonly capacitySampledAtByWorkspace = new Map<string, number>();
  private readonly pendingCapacityWorkspaces = new Set<string>();
  private capacitySamplerPromise: Promise<void> | undefined;
  private runtimeHooks: OutboxDispatcherRuntimeHooks | undefined;
  private closed = false;
  public constructor(private readonly operationTimeoutMillis: number) {}
  public get configured(): boolean {
    return this.runtimeHooks !== undefined;
  }
  public configure(hooks: OutboxDispatcherRuntimeHooks): void {
    this.runtimeHooks = hooks;
  }
  public stop(): void {
    this.closed = true;
    this.pendingCapacityWorkspaces.clear();
  }
  public pending(): Promise<void> | undefined {
    return this.capacitySamplerPromise;
  }
  public schedule(workspaceId: string): void {
    if (this.runtimeHooks === undefined || this.closed) return;
    const now = Date.now();
    const sampledAt = this.capacitySampledAtByWorkspace.get(workspaceId);
    if (
      sampledAt !== undefined &&
      now - sampledAt < WORKSPACE_CAPACITY_SAMPLE_INTERVAL_MILLIS
    )
      return;
    if (
      this.pendingCapacityWorkspaces.size >=
      MAX_PENDING_WORKSPACE_CAPACITY_SAMPLES
    )
      return;

    if (
      this.capacitySampledAtByWorkspace.size >=
      MAX_TRACKED_WORKSPACE_CAPACITY_SAMPLES
    ) {
      const oldestWorkspace = this.capacitySampledAtByWorkspace
        .keys()
        .next().value;
      if (oldestWorkspace !== undefined)
        this.capacitySampledAtByWorkspace.delete(oldestWorkspace);
    }
    this.capacitySampledAtByWorkspace.set(workspaceId, now);
    this.pendingCapacityWorkspaces.add(workspaceId);
    this.capacitySamplerPromise ??= this.drainWorkspaceCapacitySamples();
  }
  private async drainWorkspaceCapacitySamples(): Promise<void> {
    try {
      while (!this.closed) {
        const workspaceId = this.pendingCapacityWorkspaces
          .values()
          .next().value;
        if (workspaceId === undefined) return;
        this.pendingCapacityWorkspaces.delete(workspaceId);
        await observeDispatchCapacity(
          this.runtimeHooks,
          workspaceId,
          this.operationTimeoutMillis,
        );
      }
    } finally {
      this.capacitySamplerPromise = undefined;
    }
  }
}
