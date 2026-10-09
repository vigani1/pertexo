import type {
  WorkspaceInboxChange,
  WorkspaceInboxFoldStore,
} from '@pertexo/database/inbox';
import type { WorkspaceInboxHintPublisher } from '@pertexo/queue';

import {
  createPollingRuntime,
  reportDiagnostic,
  type PollingRuntime,
} from '../runtime/polling.js';

export type WorkspaceInboxRuntime = PollingRuntime;

export const WORKSPACE_INBOX_RUNTIME = Symbol('WORKSPACE_INBOX_RUNTIME');

export type WorkspaceInboxRuntimeOptions = Readonly<{
  /** Pending failures folded per database call. */
  foldBatchSize: number;
  /** Idle wait between folds once nothing is pending. */
  foldPollMillis: number;
}>;

export type WorkspaceInboxDiagnostics = Readonly<{
  cycleFailed(): void;
  hintFailed(): void;
}>;

/** Folds back to back while a burst is pending, then yields to the poll. */
const MAX_FOLDS_PER_CYCLE = 20;

/**
 * ADR 055: folds pending inbox failures into their workflows' threads and
 * hints each changed workspace's open inboxes. Every worker may run it; the
 * fold takes disjoint work. Retention removes idle threads.
 */
export function createWorkspaceInboxRuntime(
  store: WorkspaceInboxFoldStore,
  publisher: WorkspaceInboxHintPublisher,
  options: WorkspaceInboxRuntimeOptions,
  diagnostics: WorkspaceInboxDiagnostics,
): WorkspaceInboxRuntime {
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
  return createPollingRuntime({
    name: 'Workspace inbox',
    pollMillis: options.foldPollMillis,
    checkStore: (signal) => store.checkReadiness(signal),
    cycle: fold,
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
