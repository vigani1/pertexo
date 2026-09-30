import type {
  WorkspaceInboxChange,
  WorkspaceInboxFoldStore,
} from '@pertexo/database/execution';
import type { WorkspaceInboxHintPublisher } from '@pertexo/queue';

import {
  createPollingRuntime,
  reportDiagnostic,
  type PollingRuntime,
} from '../runtime/polling-runtime.js';

export type WorkspaceInboxRuntime = PollingRuntime;

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
  let nextExpiryAt = 0;
  const hint = async (changes: readonly WorkspaceInboxChange[]) => {
    const published = await Promise.allSettled(
      changes.map((change) => publisher.publish(change)),
    );
    // A lost hint only delays a refresh; open inboxes also refetch on focus.
    if (published.some(({ status }) => status === 'rejected'))
      reportDiagnostic(diagnostics.hintFailed);
  };
  const fold = async (signal: AbortSignal) => {
    for (let round = 0; round < MAX_FOLDS_PER_CYCLE; round += 1) {
      const changes = await store.foldPending(options.foldBatchSize, signal);
      if (changes.length === 0) return;
      await hint(changes);
    }
  };
  const expire = async (signal: AbortSignal) => {
    if (Date.now() < nextExpiryAt) return;
    for (let batch = 0; batch < MAX_EXPIRY_BATCHES_PER_SWEEP; batch += 1)
      if (
        (await store.expireThreads(EXPIRY_BATCH_SIZE, signal)) <
        EXPIRY_BATCH_SIZE
      )
        break;
    nextExpiryAt = Date.now() + options.expiryPollMillis;
  };
  return createPollingRuntime({
    name: 'Workspace inbox',
    pollMillis: options.foldPollMillis,
    checkCompatibility: (signal) => store.checkReadiness(signal),
    cycle: async (signal) => {
      await fold(signal);
      await expire(signal);
    },
    cycleFailed: diagnostics.cycleFailed,
    release: async () => {
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
    },
  });
}
