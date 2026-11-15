import {
  DEFAULT_ARTIFACT_COUNT_LIMIT,
  DEFAULT_RUN_CAPACITY_LIMITS,
  DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT,
} from '@pertexo/policy';

/** Startup combines each concern's defaults before applying operator settings. */
export const DEFAULT_INSTANCE_LIMITS = Object.freeze({
  ...DEFAULT_RUN_CAPACITY_LIMITS,
  artifactCountLimit: DEFAULT_ARTIFACT_COUNT_LIMIT,
  webhookEndpointBurstLimit: DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT,
});

/** The most an operator may raise each limit to: what the database's columns hold. */
export const INSTANCE_LIMIT_MAXIMUMS = Object.freeze({
  activeRunLimit: 10_000,
  queuedRunLimit: 100_000,
  artifactCountLimit: 10_000_000,
  webhookEndpointBurstLimit: 1_000_000,
});
