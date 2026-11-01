const FIRST_RETRY_MILLIS = 60_000;
const LONGEST_RETRY_MILLIS = 3_600_000;

type Attempt = Readonly<{ failures: number; retryAt: number }>;

/** How long to leave someone alone after this many failures in a row. */
function retryDelayMillis(failures: number): number {
  return Math.min(
    FIRST_RETRY_MILLIS * 2 ** (failures - 1),
    LONGEST_RETRY_MILLIS,
  );
}

/**
 * Who failed recently, so a mail that keeps failing costs one attempt per delay
 * rather than one per cycle. In memory: after a restart everyone gets one more
 * try, which costs nothing, and several workers each keep their own.
 */
export function createPersonBackoff() {
  const attempts = new Map<string, Attempt>();
  return {
    isWaiting: (key: string) => {
      const attempt = attempts.get(key);
      return attempt !== undefined && attempt.retryAt > Date.now();
    },
    failed: (key: string) => {
      const failures = (attempts.get(key)?.failures ?? 0) + 1;
      attempts.set(key, {
        failures,
        retryAt: Date.now() + retryDelayMillis(failures),
      });
      return failures;
    },
    succeeded: (key: string) => attempts.delete(key),
  };
}
