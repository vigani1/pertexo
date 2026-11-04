import { DEFAULT_RUN_CAPACITY_LIMITS } from '@pertexo/core/runs';
import { DEFAULT_ARTIFACT_COUNT_LIMIT } from '@pertexo/core/artifacts';
import { DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT } from '@pertexo/core/triggers';

/** Startup combines each concern's defaults before applying operator settings. */
export const DEFAULT_INSTANCE_LIMITS = Object.freeze({
  ...DEFAULT_RUN_CAPACITY_LIMITS,
  artifactCountLimit: DEFAULT_ARTIFACT_COUNT_LIMIT,
  webhookEndpointBurstLimit: DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT,
});
