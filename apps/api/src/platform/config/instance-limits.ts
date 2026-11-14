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
