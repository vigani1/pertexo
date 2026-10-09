import type { QueueConsumer } from '@pertexo/queue';

import { waitForSupervisorDelay } from './abortable-delay.js';
import { boundedBackgroundTask } from './background-task-deadline.js';
import { reportDiagnostic } from './polling.js';

/** A resource the runtime owns; undefined when it was never acquired. */
export type Owner = Readonly<{ close?(): unknown }> | undefined;

export type ScannerRuntime = Readonly<{
  consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export type ScannerRuntimeDefinition = Readonly<{
  /** Names the runtime in readiness and shutdown errors, e.g. "Trigger". */
  name: string;
  consumer: QueueConsumer;
  /** Closed after the consumer and scanner stop. */
  owners: readonly Owner[];
  pollIntervalMillis: number;
  shutdownTimeoutMillis: number;
  scan(signal: AbortSignal): Promise<void>;
  scanFailed?(error: unknown): void;
  /** Further readiness, checked once the latest scan succeeded. */
  checkReadiness?(): Promise<void>;
  /** Work to settle after the consumer stops and before the owners close. */
  afterConsumerClose?(): Promise<void>;
}>;

function rejectedReasons(
  results: readonly PromiseSettledResult<unknown>[],
): unknown[] {
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

/** Closes every owner, each within the deadline, and returns the failures. */
export async function closeOwners(
  owners: readonly Owner[],
  timeoutMillis: number,
): Promise<unknown[]> {
  return rejectedReasons(
    await Promise.allSettled(
      owners.map((owner) =>
        boundedBackgroundTask(
          Promise.resolve().then(() => owner?.close?.()),
          timeoutMillis,
        ),
      ),
    ),
  );
}

/**
 * A queue consumer plus a scanner that runs every poll interval. It is ready
 * once the first scan settles while the latest scan succeeded. Close stops
 * the scanner and drains the consumer within the shutdown deadline, then
 * closes the owners; past the deadline, the owners close once the drain
 * settles.
 */
export function createScannerRuntime(
  definition: ScannerRuntimeDefinition,
): ScannerRuntime {
  const controller = new AbortController();
  const { signal } = controller;
  const firstScan = Promise.withResolvers<undefined>();
  let latestScanFailed = true;
  const loop = (async () => {
    while (!signal.aborted) {
      try {
        await definition.scan(signal);
        latestScanFailed = false;
      } catch (error: unknown) {
        // The signal can change while the scan awaits I/O.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!signal.aborted) {
          latestScanFailed = true;
          reportDiagnostic(() => {
            definition.scanFailed?.(error);
          });
        }
      }
      firstScan.resolve(undefined);
      await waitForSupervisorDelay(definition.pollIntervalMillis, signal);
    }
  })();

  const closed = (): Error => new Error(`${definition.name} runtime is closed`);
  const close = async (): Promise<void> => {
    controller.abort();
    firstScan.resolve(undefined);
    const drain = (async () => [
      ...(await Promise.allSettled([
        Promise.resolve().then(() => definition.consumer.close()),
        loop,
      ])),
      ...(await Promise.allSettled([
        Promise.resolve().then(() => definition.afterConsumerClose?.()),
      ])),
    ])();
    let drained: PromiseSettledResult<unknown>[];
    try {
      drained = await boundedBackgroundTask(
        drain,
        definition.shutdownTimeoutMillis,
      );
    } catch (error: unknown) {
      void drain
        .then(() =>
          closeOwners(definition.owners, definition.shutdownTimeoutMillis),
        )
        .catch(() => undefined);
      throw error;
    }
    const failures = [
      ...rejectedReasons(drained),
      ...(await closeOwners(
        definition.owners,
        definition.shutdownTimeoutMillis,
      )),
    ];
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `${definition.name} runtime shutdown failed`,
      );
  };

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer: definition.consumer,
    checkReadiness: async (): Promise<void> => {
      if (signal.aborted) throw closed();
      await firstScan.promise;
      // Close can begin while the first scan awaits I/O.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) throw closed();
      if (latestScanFailed)
        throw new Error(`${definition.name} latest scan failed`);
      await definition.checkReadiness?.();
    },
    close: (): Promise<void> => {
      closePromise ??= close();
      return closePromise;
    },
  });
}
