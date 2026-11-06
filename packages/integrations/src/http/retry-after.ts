const MINIMUM_RETRY_AFTER_MILLIS = 1_000;

/** A provider minimum is never shortened to the platform's automatic retry ceiling. */
export function parseRetryAfterMillis(
  value: string | undefined,
  nowMillis = Date.now(),
  fallbackMillis = MINIMUM_RETRY_AFTER_MILLIS,
): number {
  if (value === undefined || value === '') return fallbackMillis;
  if (/^\d{1,9}$/u.test(value))
    return Number(value) === 0 ? fallbackMillis : Number(value) * 1_000;
  // HTTP dates have a textual month; don't reinterpret malformed seconds as dates.
  if (!/[A-Za-z]{3}/u.test(value)) return fallbackMillis;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > nowMillis
    ? Math.max(date - nowMillis, MINIMUM_RETRY_AFTER_MILLIS)
    : fallbackMillis;
}
