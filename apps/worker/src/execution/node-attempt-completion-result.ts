import type { NodeAttemptLease } from '@pertexo/database/execution';
import type { RunEventNotificationPublisher } from '@pertexo/queue';

/** Completion remains authoritative even when its realtime resync hint fails. */
export async function completionResult(
  dependencies: Readonly<{ notifications?: RunEventNotificationPublisher }>,
  lease: NodeAttemptLease,
  kind: 'committed' | 'duplicate',
): Promise<Readonly<{ kind: 'committed' | 'duplicate' }>> {
  if (kind === 'committed' && dependencies.notifications !== undefined) {
    try {
      await dependencies.notifications.resync({
        workspaceId: lease.workspaceId,
        runId: lease.runId,
      });
    } catch {
      // PostgreSQL is authoritative; a later hint or reconnect backfills.
    }
  }
  return Object.freeze({ kind });
}
