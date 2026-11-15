import { EVENT_COORDINATION_LIMITS } from '@pertexo/workflow-model';

/**
 * Whether holding one more event, or replacing the one it supersedes, would
 * pass the workspace's pending event count or input bytes.
 */
export function pendingEventQuotaExceeded(
  budget: Readonly<{ count: number; bytes: number }> | undefined,
  replaced: Readonly<{ input_bytes: number }> | undefined,
  bytes: number,
): boolean {
  return (
    (budget?.count ?? 0) + (replaced === undefined ? 1 : 0) >
      EVENT_COORDINATION_LIMITS.pendingEvents ||
    (budget?.bytes ?? 0) - (replaced?.input_bytes ?? 0) + bytes >
      EVENT_COORDINATION_LIMITS.pendingBytes
  );
}
