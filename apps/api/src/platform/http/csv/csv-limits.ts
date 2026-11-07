export const EXPORT_MAX_MILLIS = 5 * 60 * 1000;
export const EXPORT_IDLE_MILLIS = 60 * 1000;
export const EXPORT_INSTANCE_LIMIT = 2;
// Survive bounded admission/cleanup delays without expiring during a valid export.
export const EXPORT_SLOT_MILLIS = EXPORT_MAX_MILLIS + 30 * 1000;

export function exportBudgetMillis(
  table: Readonly<{ storedBytes: number }>,
): number {
  return Math.min(
    EXPORT_MAX_MILLIS,
    60_000 + Math.ceil(table.storedBytes / 1_048_576) * 1000,
  );
}
