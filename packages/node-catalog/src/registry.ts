import {
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
} from '@pertexo/integrations';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import {
  CORE_REGISTRY_RELEASE_SUPPORT,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
} from '@pertexo/nodes-core';

const httpExecutorAbi = HTTP_REQUEST_MANIFEST.executorAbi;
if (httpExecutorAbi === undefined)
  throw new Error('HTTP Request manifest must pin its executor ABI');

export const PLATFORM_REGISTRY_RELEASE_HTTP_STAGED =
  createRegistryReleaseSuccessor({
    previous: CORE_REGISTRY_RELEASE_SUCCESSOR,
    epoch: CORE_REGISTRY_RELEASE_SUCCESSOR.epoch + 1,
    definitions: [
      ...CORE_REGISTRY_RELEASE_SUCCESSOR.definitions,
      HTTP_REQUEST_MANIFEST,
    ],
    executors: [
      ...CORE_REGISTRY_RELEASE_SUCCESSOR.executors,
      {
        executor: HTTP_REQUEST_MANIFEST.executor,
        abiVersion: httpExecutorAbi,
        definitions: [HTTP_REQUEST_MANIFEST.definition],
        lifecycle: 'staged',
        policyReferences: HTTP_REQUEST_MANIFEST.policyReferences,
      },
    ],
    policies: [
      ...CORE_REGISTRY_RELEASE_SUCCESSOR.policies,
      HTTP_REQUEST_NETWORK_POLICY,
      HTTP_REQUEST_VALUE_POLICY,
    ],
  });

export const PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
    epoch: PLATFORM_REGISTRY_RELEASE_HTTP_STAGED.epoch + 1,
    definitions: PLATFORM_REGISTRY_RELEASE_HTTP_STAGED.definitions,
    executors: PLATFORM_REGISTRY_RELEASE_HTTP_STAGED.executors.map(
      (executor) =>
        executor.executor.key === HTTP_REQUEST_MANIFEST.executor.key &&
        executor.executor.version === HTTP_REQUEST_MANIFEST.executor.version
          ? { ...executor, lifecycle: 'active' as const }
          : executor,
    ),
    policies: PLATFORM_REGISTRY_RELEASE_HTTP_STAGED.policies,
  });

/** Complete audit/test history; never pass this to one serving artifact. */
export const PLATFORM_REGISTRY_RELEASE_HISTORY = Object.freeze([
  ...CORE_REGISTRY_RELEASE_SUPPORT,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
]);

/** Backward-compatible default cohort until deployment selects a Phase 4 cohort. */
export const PLATFORM_REGISTRY_RELEASE_SUPPORT = CORE_REGISTRY_RELEASE_SUPPORT;

/** First Phase 4 artifact: current core release plus staged HTTP successor. */
export const PLATFORM_HTTP_STAGING_RELEASE_SUPPORT = Object.freeze([
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
]);

/** Second Phase 4 artifact: staged predecessor plus active HTTP successor. */
export const PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT = Object.freeze([
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
]);

export const PLATFORM_RELEASE_COHORTS = Object.freeze([
  'core',
  'http_staging',
  'http_activation',
] as const);
export type PlatformReleaseCohort = (typeof PLATFORM_RELEASE_COHORTS)[number];

export function platformRegistryReleaseSupport(cohort: PlatformReleaseCohort) {
  switch (cohort) {
    case 'core':
      return PLATFORM_REGISTRY_RELEASE_SUPPORT;
    case 'http_staging':
      return PLATFORM_HTTP_STAGING_RELEASE_SUPPORT;
    case 'http_activation':
      return PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT;
  }
}

/** Release whose executors the cohort's worker actually dispatches. */
export function platformServingRegistryRelease(cohort: PlatformReleaseCohort) {
  switch (cohort) {
    case 'core':
    case 'http_staging':
      return CORE_REGISTRY_RELEASE_SUCCESSOR;
    case 'http_activation':
      return PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE;
  }
}
