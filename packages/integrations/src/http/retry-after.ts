const MINIMUM_RETRY_AFTER_MILLIS = 1_000;

/** Provider retry policy accepts bounded integer seconds, not HTTP dates. */
export function parseBoundedRetryAfterMillis(
  value: string | undefined,
  maximumMillis: number,
): number {
  if (value === undefined || !/^\d{1,9}$/u.test(value))
    return MINIMUM_RETRY_AFTER_MILLIS;
  return Math.min(
    Math.max(Number(value) * 1_000, MINIMUM_RETRY_AFTER_MILLIS),
    maximumMillis,
  );
}
