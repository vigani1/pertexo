import type {
  WorkspaceInboxChange,
  WorkspaceInboxFoldStore,
} from '@pertexo/database/execution';
import type { WorkspaceInboxHintPublisher } from '@pertexo/queue';

import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';

export interface WorkspaceInboxRuntime {
  start(): void;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export const WORKSPACE_INBOX_RUNTIME = Symbol('WORKSPACE_INBOX_RUNTIME');

export type WorkspaceInboxRuntimeOptions = Readonly<{
  /** Pending failures folded per database call. */
  foldBatchSize: number;
  /** Idle wait between folds once nothing is pending. */
  foldPollMillis: number;
  /** Wait between sweeps for threads idle past their window. */
  expiryPollMillis: number;
}>;

export type WorkspaceInboxDiagnostics = Readonly<{
  cycleFailed(): void;
  hintFailed(): void;
}>;

/** Folds back to back while a burst is pending, then yields to the poll. */
const MAX_FOLDS_PER_CYCLE = 20;
const EXPIRY_BATCH_SIZE = 1_000;
const MAX_EXPIRY_BATCHES_PER_SWEEP = 20;

/**
 * ADR 055: folds pending inbox failures into their workflows' threads, expires
 * idle threads, and hints each changed workspace's open inboxes. Every worker
 * may run it; the database commands take disjoint work.
 */
export function createWorkspaceInboxRuntime(
  store: WorkspaceInboxFoldStore,
  publisher: WorkspaceInboxHintPublisher,
  options: WorkspaceInboxRuntimeOptions,
  diagnostics: WorkspaceInboxDiagnostics,
): WorkspaceInboxRuntime {
  const controller = new AbortController();
  const { signal } = controller;
  let firstCycle: PromiseWithResolvers<undefined> | undefined;
  let loop: Promise<void> | undefined;
  let compatible = false;
  let latestCycleFailed = true;
  let nextExpiryAt = 0;

  const report = (diagnostic: () => void): void => {
    try {
      diagnostic();
    } catch {
      // Diagnostics cannot change inbox recovery or shutdown ownership.
    }
  };
  const hint = async (changes: readonly WorkspaceInboxChange[]) => {
    const published = await Promise.allSettled(
      changes.map((change) => publisher.publish(change)),
    );
    // A lost hint only delays a refresh; open inboxes also refetch on focus.
    if (published.some(({ status }) => status === 'rejected'))
      report(diagnostics.hintFailed);
  };
  const fold = async () => {
    for (let round = 0; round < MAX_FOLDS_PER_CYCLE; round += 1) {
      const changes = await store.foldPending(options.foldBatchSize, signal);
      if (changes.length === 0) return;
      await hint(changes);
    }
  };
  const expire = async () => {
    if (Date.now() < nextExpiryAt) return;
    for (let batch = 0; batch < MAX_EXPIRY_BATCHES_PER_SWEEP; batch += 1)
      if (
        (await store.expireThreads(EXPIRY_BATCH_SIZE, signal)) <
        EXPIRY_BATCH_SIZE
      )
        break;
    nextExpiryAt = Date.now() + options.expiryPollMillis;
  };
  const cycle = async () => {
    // Startup compatibility: never run commands other than the reviewed ones.
    if (!compatible) {
      await store.checkReadiness(signal);
      compatible = true;
    }
    await fold();
    await expire();
  };
  const run = async (settled: PromiseWithResolvers<undefined>) => {
    while (!signal.aborted) {
      try {
        await cycle();
        latestCycleFailed = false;
      } catch {
        // The signal can change while the cycle awaits I/O.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted) break;
        latestCycleFailed = true;
        report(diagnostics.cycleFailed);
      }
      settled.resolve(undefined);
      await waitForSupervisorDelay(options.foldPollMillis, signal);
    }
    settled.resolve(undefined);
  };

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    start: () => {
      if (loop !== undefined || signal.aborted) return;
      firstCycle = Promise.withResolvers<undefined>();
      loop = run(firstCycle);
    },
    checkReadiness: async () => {
      if (signal.aborted) throw new Error('Workspace inbox runtime is closed');
      if (firstCycle === undefined)
        throw new Error('Workspace inbox runtime has not started');
      await firstCycle.promise;
      if (!compatible)
        throw new Error('Workspace inbox commands are incompatible');
      if (latestCycleFailed)
        throw new Error('Workspace inbox latest cycle failed');
    },
    close: () => {
      closePromise ??= (async () => {
        controller.abort();
        firstCycle?.resolve(undefined);
        await loop;
        const closed = await Promise.allSettled([
          store.close(),
          publisher.close(),
        ]);
        const failures = closed.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, 'Workspace inbox shutdown failed');
      })();
      return closePromise;
    },
  });
}
