export const EXPORT_MAX_MILLIS = 5 * 60 * 1000;
export const EXPORT_IDLE_MILLIS = 60 * 1000;
// An export's budget: a minute, plus a second for each MB the table stores.
const EXPORT_BASE_MILLIS = 60 * 1000;
const EXPORT_MILLIS_PER_MB = 1_000;
export const EXPORT_INSTANCE_LIMIT = 2;
// Survive bounded admission/cleanup delays without expiring during a valid export.
export const EXPORT_SLOT_MILLIS = EXPORT_MAX_MILLIS + 30 * 1000;

export function exportBudgetMillis(
  table: Readonly<{ storedBytes: number }>,
): number {
  return Math.min(
    EXPORT_MAX_MILLIS,
    EXPORT_BASE_MILLIS +
      Math.ceil(table.storedBytes / 1_024 / 1_024) * EXPORT_MILLIS_PER_MB,
  );
}
