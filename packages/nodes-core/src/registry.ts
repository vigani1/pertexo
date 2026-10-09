import { createNodeCatalog, executorManifestFor } from '@pertexo/node-sdk';

import { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
import { CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY } from './policies.js';

const CORE_NODE_MANIFESTS = CORE_NODE_DEFINITION_REGISTRATIONS.map(
  ({ manifest }) => manifest,
);

/** Every core node, each with its own executor. */
export const CORE_NODE_CATALOG = createNodeCatalog({
  definitions: CORE_NODE_MANIFESTS,
  executors: CORE_NODE_MANIFESTS.map(executorManifestFor),
  policies: [CORE_BOUNDED_JSON_POLICY, CORE_JSONATA_POLICY],
});
