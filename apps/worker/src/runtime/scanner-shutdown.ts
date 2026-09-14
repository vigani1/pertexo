import type { QueueConsumer } from '@pertexo/queue';

import { boundedBackgroundTask } from './background-task-deadline.js';

type ScannerShutdownOptions = Readonly<{
  consumer: QueueConsumer;
  observeDeferred: (
    activity: Promise<readonly PromiseSettledResult<unknown>[]>,
  ) => void;
  scannerAbort: AbortController;
  scannerLoop: Promise<void>;
  settleFirstScan: () => void;
  timeoutMillis: number;
}>;

export async function drainScannerActivity(
  options: ScannerShutdownOptions,
): Promise<readonly PromiseSettledResult<unknown>[]> {
  options.scannerAbort.abort();
  options.settleFirstScan();
  const activity = Promise.allSettled([
    Promise.resolve().then(() => options.consumer.close()),
    options.scannerLoop,
  ]);
  try {
    return await boundedBackgroundTask(activity, options.timeoutMillis);
  } catch (error: unknown) {
    options.observeDeferred(activity);
    throw error;
  }
}
