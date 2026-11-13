/**
 * How long Pertexo keeps each kind of data. The server deletes on these
 * numbers and the browser says them, so the two can't drift apart.
 */
export const DATA_RETENTION_DAYS = Object.freeze({
  /** A run's inputs, outputs and step details. */
  runDetails: 30,
  /** A run's status and timing, for history and usage. */
  runSummaries: 90,
  /** A draft test's runs and the data they recorded. */
  testRuns: 7,
  /** A pinned sample of a step's output. */
  stepSamples: 30,
  /** A finished upload that nothing refers to yet. */
  unusedUploads: 30,
} as const);

/** How long a webhook's test URL waits for its one request. */
export const WEBHOOK_TEST_CAPTURE_SECONDS = 120;
