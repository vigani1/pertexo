import { EXPORT_IDLE_MILLIS } from './limits.js';

/** Observe socket writes, not source production or PassThrough buffering. */
export function watchExportProgress(
  response: Readonly<{ socket: Readonly<{ bytesWritten: number }> | null }>,
  stalled: () => void,
): () => void {
  let bytes = response.socket?.bytesWritten ?? 0;
  let progressedAt = performance.now();
  const timer = setInterval(() => {
    const written = response.socket?.bytesWritten ?? bytes;
    if (written > bytes) {
      bytes = written;
      progressedAt = performance.now();
    } else if (performance.now() - progressedAt >= EXPORT_IDLE_MILLIS) {
      clearInterval(timer);
      stalled();
    }
  }, 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
