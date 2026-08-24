import {
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
} from '@pertexo/integrations';
import { createRegistryReleaseSuccessor } from '@pertexo/node-sdk';
import {
  CORE_CONDITION_MANIFEST,
  CORE_MERGE_MANIFEST,
  CORE_PARALLEL_MANIFEST,
  CORE_REGISTRY_RELEASE_SUPPORT,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  CORE_SWITCH_MANIFEST,
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

const conditionExecutorAbi = CORE_CONDITION_MANIFEST.executorAbi;
if (conditionExecutorAbi === undefined)
  throw new Error('Condition manifest must pin its executor ABI');

export const PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    epoch: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.epoch + 1,
    definitions: [
      ...PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.definitions,
      CORE_CONDITION_MANIFEST,
    ],
    executors: [
      ...PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.executors,
      {
        executor: CORE_CONDITION_MANIFEST.executor,
        abiVersion: conditionExecutorAbi,
        definitions: [CORE_CONDITION_MANIFEST.definition],
        lifecycle: 'staged',
        policyReferences: CORE_CONDITION_MANIFEST.policyReferences,
      },
    ],
    policies: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.policies,
  });

export const PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
    epoch: PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED.epoch + 1,
    definitions: PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED.definitions,
    executors: PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED.executors.map(
      (executor) =>
        executor.executor.key === CORE_CONDITION_MANIFEST.executor.key &&
        executor.executor.version === CORE_CONDITION_MANIFEST.executor.version
          ? { ...executor, lifecycle: 'active' as const }
          : executor,
    ),
    policies: PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED.policies,
  });

const switchExecutorAbi = CORE_SWITCH_MANIFEST.executorAbi;
if (switchExecutorAbi === undefined)
  throw new Error('Switch manifest must pin its executor ABI');

export const PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
    epoch: PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE.epoch + 1,
    definitions: [
      ...PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE.definitions,
      CORE_SWITCH_MANIFEST,
    ],
    executors: [
      ...PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE.executors,
      {
        executor: CORE_SWITCH_MANIFEST.executor,
        abiVersion: switchExecutorAbi,
        definitions: [CORE_SWITCH_MANIFEST.definition],
        lifecycle: 'staged',
        policyReferences: CORE_SWITCH_MANIFEST.policyReferences,
      },
    ],
    policies: PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE.policies,
  });

export const PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
    epoch: PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED.epoch + 1,
    definitions: PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED.definitions,
    executors: PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED.executors.map(
      (executor) =>
        executor.executor.key === CORE_SWITCH_MANIFEST.executor.key &&
        executor.executor.version === CORE_SWITCH_MANIFEST.executor.version
          ? { ...executor, lifecycle: 'active' as const }
          : executor,
    ),
    policies: PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED.policies,
  });

const parallelExecutorAbi = CORE_PARALLEL_MANIFEST.executorAbi;
if (parallelExecutorAbi === undefined)
  throw new Error('Parallel manifest must pin its executor ABI');

export const PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
    epoch: PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE.epoch + 1,
    definitions: [
      ...PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE.definitions,
      CORE_PARALLEL_MANIFEST,
    ],
    executors: [
      ...PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE.executors,
      {
        executor: CORE_PARALLEL_MANIFEST.executor,
        abiVersion: parallelExecutorAbi,
        definitions: [CORE_PARALLEL_MANIFEST.definition],
        lifecycle: 'staged',
        policyReferences: CORE_PARALLEL_MANIFEST.policyReferences,
      },
    ],
    policies: PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE.policies,
  });

export const PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
    epoch: PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED.epoch + 1,
    definitions: PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED.definitions,
    executors: PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED.executors.map(
      (executor) =>
        executor.executor.key === CORE_PARALLEL_MANIFEST.executor.key &&
        executor.executor.version === CORE_PARALLEL_MANIFEST.executor.version
          ? { ...executor, lifecycle: 'active' as const }
          : executor,
    ),
    policies: PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED.policies,
  });

const mergeExecutorAbi = CORE_MERGE_MANIFEST.executorAbi;
if (mergeExecutorAbi === undefined)
  throw new Error('Merge manifest must pin its executor ABI');

export const PLATFORM_REGISTRY_RELEASE_MERGE_STAGED =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
    epoch: PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE.epoch + 1,
    definitions: [
      ...PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE.definitions,
      CORE_MERGE_MANIFEST,
    ],
    executors: [
      ...PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE.executors,
      {
        executor: CORE_MERGE_MANIFEST.executor,
        abiVersion: mergeExecutorAbi,
        definitions: [CORE_MERGE_MANIFEST.definition],
        lifecycle: 'staged',
        policyReferences: CORE_MERGE_MANIFEST.policyReferences,
      },
    ],
    policies: PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE.policies,
  });

export const PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE =
  createRegistryReleaseSuccessor({
    previous: PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
    epoch: PLATFORM_REGISTRY_RELEASE_MERGE_STAGED.epoch + 1,
    definitions: PLATFORM_REGISTRY_RELEASE_MERGE_STAGED.definitions,
    executors: PLATFORM_REGISTRY_RELEASE_MERGE_STAGED.executors.map(
      (executor) =>
        executor.executor.key === CORE_MERGE_MANIFEST.executor.key &&
        executor.executor.version === CORE_MERGE_MANIFEST.executor.version
          ? { ...executor, lifecycle: 'active' as const }
          : executor,
    ),
    policies: PLATFORM_REGISTRY_RELEASE_MERGE_STAGED.policies,
  });

/** Complete audit/test history; never pass this to one serving artifact. */
export const PLATFORM_REGISTRY_RELEASE_HISTORY = Object.freeze([
  ...CORE_REGISTRY_RELEASE_SUPPORT,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
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

/** Condition staging artifact: active HTTP predecessor plus staged Condition. */
export const PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT = Object.freeze([
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
]);

/** Condition activation artifact: staged predecessor plus active Condition. */
export const PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT = Object.freeze([
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
]);

/** Switch staging artifact: active Condition predecessor plus staged Switch. */
export const PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT = Object.freeze([
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
]);

/** Switch activation artifact: staged predecessor plus active Switch. */
export const PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT = Object.freeze([
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
]);

export const PLATFORM_RELEASE_COHORTS = Object.freeze([
  'core',
  'http_staging',
  'http_activation',
  'condition_staging',
  'condition_activation',
  'switch_staging',
  'switch_activation',
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
    case 'condition_staging':
      return PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT;
    case 'condition_activation':
      return PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT;
    case 'switch_staging':
      return PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT;
    case 'switch_activation':
      return PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT;
  }
}

/** Retained immutable releases executable by a cohort, distinct from readiness. */
export function platformExecutableRegistryHistory(
  cohort: PlatformReleaseCohort,
) {
  const maximumEpoch = platformRegistryReleaseSupport(cohort).at(-1)?.epoch;
  if (maximumEpoch === undefined)
    throw new Error('Platform release cohort is empty');
  return Object.freeze(
    PLATFORM_REGISTRY_RELEASE_HISTORY.filter(
      ({ epoch }) => epoch <= maximumEpoch,
    ),
  );
}

/** Release whose executors the cohort's worker actually dispatches. */
export function platformServingRegistryRelease(cohort: PlatformReleaseCohort) {
  switch (cohort) {
    case 'core':
    case 'http_staging':
      return CORE_REGISTRY_RELEASE_SUCCESSOR;
    case 'http_activation':
      return PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE;
    case 'condition_staging':
      return PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE;
    case 'condition_activation':
      return PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE;
    case 'switch_staging':
      return PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE;
    case 'switch_activation':
      return PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE;
  }
}

export function platformServingReleaseRequiresHttpCapabilities(
  cohort: PlatformReleaseCohort,
): boolean {
  return platformServingRegistryRelease(cohort).executors.some(
    ({ executor, lifecycle }) =>
      executor.key === HTTP_REQUEST_MANIFEST.executor.key &&
      executor.version === HTTP_REQUEST_MANIFEST.executor.version &&
      lifecycle === 'active',
  );
}
