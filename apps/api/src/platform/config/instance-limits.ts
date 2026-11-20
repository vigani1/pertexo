import {
  DEFAULT_ARTIFACT_COUNT_LIMIT,
  DEFAULT_RUN_CAPACITY_LIMITS,
  DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT,
} from '@pertexo/policy';

/**
 * Requests the API holds at once before it answers 503. Each costs about
 * 0.24 MiB while it waits (S5, minimum server): 256 on a ~370 MiB base stays
 * well under the API's 512 MiB cap.
 */
export const DEFAULT_IN_FLIGHT_REQUEST_LIMIT = 256;

/** Startup combines each concern's defaults before applying operator settings. */
export const DEFAULT_INSTANCE_LIMITS = Object.freeze({
  ...DEFAULT_RUN_CAPACITY_LIMITS,
  artifactCountLimit: DEFAULT_ARTIFACT_COUNT_LIMIT,
  webhookEndpointBurstLimit: DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT,
  inFlightRequestLimit: DEFAULT_IN_FLIGHT_REQUEST_LIMIT,
});

/** The most an operator may raise each limit to: what the database's columns hold, or one process serves. */
export const INSTANCE_LIMIT_MAXIMUMS = Object.freeze({
  activeRunLimit: 10_000,
  queuedRunLimit: 100_000,
  artifactCountLimit: 10_000_000,
  webhookEndpointBurstLimit: 1_000_000,
  inFlightRequestLimit: 10_000,
});
