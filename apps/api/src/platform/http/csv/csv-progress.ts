import { EXPORT_IDLE_MILLIS } from './csv-limits.js';

/** How often an export's progress is checked. */
const PROGRESS_CHECK_MILLIS = 1_000;

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
  }, PROGRESS_CHECK_MILLIS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
