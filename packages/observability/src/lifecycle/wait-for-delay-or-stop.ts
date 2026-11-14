/** The longest delay a Node timer holds before firing at once (2^31 - 1 ms). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Orderly loop stop resolves this wait; operational cancellation is distinct. */
export function waitForDelayOrStop(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_TIMER_DELAY_MS
  )
    throw new TypeError(
      'milliseconds must be a non-negative safe integer within the timer range',
    );
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
