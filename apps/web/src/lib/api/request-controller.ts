/**
 * The abort controller for one request: it follows the caller's signal and
 * aborts itself after `timeoutMs`, so a timeout is told apart from a cancel.
 */
export function requestController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutKind: string,
) {
  const controller = new AbortController();
  const timeoutReason = Object.freeze({ kind: timeoutKind });
  const forwardAbort = () => {
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = window.setTimeout(() => {
    controller.abort(timeoutReason);
  }, timeoutMs);
  return {
    signal: controller.signal,
    abort: () => {
      controller.abort();
    },
    timedOut: () => controller.signal.reason === timeoutReason,
    stopTimer: () => {
      window.clearTimeout(timeout);
    },
    dispose: () => {
      window.clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}
