import type { JobName } from '@pertexo/queue';

import type { OutboxDispatchResult as InternalOutboxDispatchResult } from '../dispatch-result.js';

/** Bounds are validated once, by the worker config. */
export type OutboxDispatcherOptions = Readonly<{
  batchSize: number;
  /** The job kinds this worker consumes; only those are dispatched. */
  jobNames: readonly JobName[];
  leaseDurationMillis: number;
  leaseOwner: string;
  operationTimeoutMillis?: number;
  /** Maximum interval while idle; publication shortens subsequent polling. */
  pollIntervalMillis?: number;
  retryDelayMillis: number;
}>;

export type OutboxDispatcherRuntimeHooks = Readonly<{
  observeWorkspaceCapacity(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<void>;
}>;

export type OutboxDispatchResult = InternalOutboxDispatchResult;
