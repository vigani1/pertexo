import { waitForSupervisorDelay } from './abortable-delay.js';

export interface PollingRuntime {
  start(): void;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

export type PollingRuntimeDefinition = Readonly<{
  /** Names the runtime in readiness errors, e.g. "Workspace inbox". */
  name: string;
  /** Idle wait between cycles. */
  pollMillis: number;
  /** Checks the runtime's store once, before the first cycle. */
  checkStore(signal: AbortSignal): Promise<void>;
  cycle(signal: AbortSignal): Promise<void>;
  cycleFailed(): void;
  /** Releases the runtime's resources once the loop has stopped. */
  release(): Promise<void>;
}>;

/** Calls a diagnostic without letting it change recovery or shutdown. */
export function reportDiagnostic(diagnostic: () => void): void {
  try {
    diagnostic();
  } catch {
    // Diagnostics cannot change recovery or shutdown ownership.
  }
}

/**
 * A worker loop that runs a cycle and waits between cycles until closed. It
 * checks its store before the first cycle, and is ready once that cycle
 * settles while the latest one succeeded.
 */
export function createPollingRuntime(
  definition: PollingRuntimeDefinition,
): PollingRuntime {
  const controller = new AbortController();
  const { signal } = controller;
  let firstCycle: PromiseWithResolvers<undefined> | undefined;
  let loop: Promise<void> | undefined;
  let storeChecked = false;
  let latestCycleFailed = true;

  const cycle = async () => {
    if (!storeChecked) {
      await definition.checkStore(signal);
      storeChecked = true;
    }
    await definition.cycle(signal);
  };
  const run = async (settled: PromiseWithResolvers<undefined>) => {
    while (!signal.aborted) {
      try {
        await cycle();
        latestCycleFailed = false;
      } catch {
        // The signal can change while the cycle awaits I/O.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted) break;
        latestCycleFailed = true;
        reportDiagnostic(definition.cycleFailed);
      }
      settled.resolve(undefined);
      await waitForSupervisorDelay(definition.pollMillis, signal);
    }
    settled.resolve(undefined);
  };

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    start: () => {
      if (loop !== undefined || signal.aborted) return;
      firstCycle = Promise.withResolvers<undefined>();
      loop = run(firstCycle);
    },
    checkReadiness: async () => {
      if (signal.aborted)
        throw new Error(`${definition.name} runtime is closed`);
      if (firstCycle === undefined)
        throw new Error(`${definition.name} runtime has not started`);
      await firstCycle.promise;
      if (!storeChecked)
        throw new Error(`${definition.name} store is not ready`);
      if (latestCycleFailed)
        throw new Error(`${definition.name} latest cycle failed`);
    },
    close: () => {
      closePromise ??= (async () => {
        controller.abort();
        firstCycle?.resolve(undefined);
        await loop;
        await definition.release();
      })();
      return closePromise;
    },
  });
}
