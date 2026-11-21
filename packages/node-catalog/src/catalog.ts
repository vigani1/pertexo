import { INTEGRATION_MODULE_REGISTRY } from './integration-modules.js';
import {
  assertAttemptOnlyManifest,
  createNodeCatalog,
  definitionIdentitySchema,
  executorManifestFor,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { PlatformNodeDefinitionUnavailableError } from './node-catalog.errors.js';
import {
  CORE_NODE_CATALOG,
  CORE_NODE_DEFINITION_REGISTRATIONS,
} from '@pertexo/nodes-core';

export type PlatformNodeDefinition = NodeDefinitionRegistration;
export { INTEGRATION_REGISTRATIONS };

const INTEGRATION_REGISTRATIONS = INTEGRATION_MODULE_REGISTRY.registrations;
const INTEGRATION_MANIFESTS = INTEGRATION_REGISTRATIONS.map(
  ({ manifest }) => manifest,
);

for (const manifest of INTEGRATION_MANIFESTS)
  assertAttemptOnlyManifest(manifest);

/** Every node the platform serves, with its runtime schemas. */
export const PLATFORM_NODE_DEFINITION_REGISTRATIONS: readonly NodeDefinitionRegistration[] =
  Object.freeze([
    ...CORE_NODE_DEFINITION_REGISTRATIONS,
    ...INTEGRATION_REGISTRATIONS,
  ]);

/** The one catalog every API and worker serves: core nodes and integrations. */
export const PLATFORM_NODE_CATALOG = createNodeCatalog({
  definitions: [...CORE_NODE_CATALOG.definitions, ...INTEGRATION_MANIFESTS],
  executors: [
    ...CORE_NODE_CATALOG.executors,
    ...INTEGRATION_MANIFESTS.map(executorManifestFor),
  ],
  policies: [
    ...CORE_NODE_CATALOG.policies,
    ...INTEGRATION_MODULE_REGISTRY.policies,
  ],
});

const REGISTRATIONS_BY_IDENTITY = new Map(
  PLATFORM_NODE_DEFINITION_REGISTRATIONS.map((registration) => [
    `${registration.manifest.definition.key}@${String(registration.manifest.definition.version)}`,
    registration,
  ]),
);

/** A definition's schemas and validators, without loading an executor. */
export function resolvePlatformNodeDefinition(
  definitionInput: unknown,
): PlatformNodeDefinition {
  // A malformed identity names no catalog node, so it is as unavailable as an
  // unknown one; drafts may hold keys the catalog's grammar never accepts.
  const identity = definitionIdentitySchema.safeParse(definitionInput);
  if (!identity.success) throw new PlatformNodeDefinitionUnavailableError();
  const { key, version } = identity.data;
  const registration = REGISTRATIONS_BY_IDENTITY.get(
    `${key}@${String(version)}`,
  );
  if (registration === undefined)
    throw new PlatformNodeDefinitionUnavailableError();
  return registration;
}
