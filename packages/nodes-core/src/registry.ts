import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';

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
