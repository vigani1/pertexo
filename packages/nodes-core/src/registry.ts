import {
  createRegistryRelease,
  createRegistryReleaseSuccessor,
  type NodeManifest,
} from '@pertexo/node-sdk';

import { CORE_MANUAL_MANIFEST } from './manual/index.js';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from './policies.js';
import { CORE_SET_MANIFEST } from './set/index.js';
import { CORE_TERMINATE_MANIFEST } from './terminate/index.js';

export const CORE_DEFINITION_MANIFESTS: readonly NodeManifest[] = Object.freeze(
  [CORE_MANUAL_MANIFEST, CORE_SET_MANIFEST, CORE_TERMINATE_MANIFEST],
);

export const CORE_REGISTRY_RELEASE = createRegistryRelease({
  epoch: 1,
  definitions: CORE_DEFINITION_MANIFESTS,
  executors: [
    {
      executor: CORE_MANUAL_MANIFEST.executor,
      abiVersion: 1,
      definitions: [CORE_MANUAL_MANIFEST.definition],
      lifecycle: 'active',
      policyReferences: [CORE_BOUNDED_JSON_POLICY],
    },
    {
      executor: CORE_SET_MANIFEST.executor,
      abiVersion: 1,
      definitions: [CORE_SET_MANIFEST.definition],
      lifecycle: 'active',
      policyReferences: [CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY],
    },
    {
      executor: CORE_TERMINATE_MANIFEST.executor,
      abiVersion: 1,
      definitions: [CORE_TERMINATE_MANIFEST.definition],
      lifecycle: 'active',
      policyReferences: [CORE_BOUNDED_JSON_POLICY],
    },
  ],
  policies: [CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY],
});

/**
 * The additive Phase 3 overlap shipped by one API/worker artifact. The
 * successor changes lifecycle metadata only; identities, schemas, policies,
 * and executor implementations remain byte-for-byte compatible.
 */
export const CORE_REGISTRY_RELEASE_SUCCESSOR = createRegistryReleaseSuccessor({
  previous: CORE_REGISTRY_RELEASE,
  epoch: CORE_REGISTRY_RELEASE.epoch + 1,
  definitions: CORE_REGISTRY_RELEASE.definitions.map((manifest) => ({
    ...manifest,
    lifecycle:
      manifest.definition.key === CORE_MANUAL_MANIFEST.definition.key
        ? ('deprecated' as const)
        : manifest.lifecycle,
  })),
  executors: CORE_REGISTRY_RELEASE.executors,
  policies: CORE_REGISTRY_RELEASE.policies,
});

export const CORE_REGISTRY_RELEASE_SUPPORT = Object.freeze([
  CORE_REGISTRY_RELEASE,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
]);
