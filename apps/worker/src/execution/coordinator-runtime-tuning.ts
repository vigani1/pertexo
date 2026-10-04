import type { CoordinatorRuntimeOptions } from './coordinator-runtime.js';

/** Existing coordinator process/scanner bounds, independent of value owners. */
export function parseCoordinatorRuntimeTuning(
  options: Pick<
    CoordinatorRuntimeOptions,
    | 'maximumAdmissions'
    | 'dueWakeupBatchSize'
    | 'dueWakeupPollIntervalMillis'
    | 'backgroundTaskShutdownTimeoutMillis'
  >,
) {
  if (
    !Number.isSafeInteger(options.maximumAdmissions) ||
    options.maximumAdmissions < 1 ||
    options.maximumAdmissions > 64
  ) {
    throw new TypeError(
      'Coordinator maximum admissions must be between 1 and 64',
    );
  }
  const dueWakeupBatchSize = options.dueWakeupBatchSize ?? 25;
  const dueWakeupPollIntervalMillis =
    options.dueWakeupPollIntervalMillis ?? 250;
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
  if (
    !Number.isSafeInteger(dueWakeupBatchSize) ||
    dueWakeupBatchSize < 1 ||
    dueWakeupBatchSize > 100
  )
    throw new TypeError('Due wakeup batch size must be between 1 and 100');
  if (
    !Number.isSafeInteger(dueWakeupPollIntervalMillis) ||
    dueWakeupPollIntervalMillis < 10 ||
    dueWakeupPollIntervalMillis > 60_000
  )
    throw new TypeError(
      'Due wakeup poll interval must be between 10 and 60000',
    );
  if (
    !Number.isSafeInteger(backgroundTaskShutdownTimeoutMillis) ||
    backgroundTaskShutdownTimeoutMillis < 1 ||
    backgroundTaskShutdownTimeoutMillis > 120_000
  )
    throw new TypeError(
      'Background task shutdown timeout must be between 1 and 120000',
    );
  return {
    dueWakeupBatchSize,
    dueWakeupPollIntervalMillis,
    backgroundTaskShutdownTimeoutMillis,
  };
}
