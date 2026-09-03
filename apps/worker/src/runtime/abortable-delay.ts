function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
  rejectOnAbort: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      if (rejectOnAbort) reject(abortError());
      else resolve();
      return;
    }

    let settled = false;
    const settle = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (aborted && rejectOnAbort) reject(abortError());
      else resolve();
    };
    const onAbort = (): void => {
      settle(true);
    };
    const timer = setTimeout(() => {
      settle(false);
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    // Close the race between the initial check and listener registration.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AbortSignal state can change asynchronously between the two reads.
    if (signal.aborted) onAbort();
  });
}

/** Wait for elapsed time; cancellation rejects work that must stop. */
export function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return waitForDelay(milliseconds, signal, true);
}

/** Wait for elapsed time or supervisor cancellation; either ends a loop wait. */
export function waitForSupervisorDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return waitForDelay(milliseconds, signal, false);
}
