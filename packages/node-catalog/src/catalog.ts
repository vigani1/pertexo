import {
  INTEGRATION_MODULES,
  type IntegrationModule,
} from '@pertexo/integrations/server';
import {
  assertAttemptOnlyManifest,
  createNodeCatalog,
  definitionIdentitySchema,
  executorManifestFor,
  NODE_CATALOG_COUNT_LIMITS,
  type NodeCatalog,
} from '@pertexo/node-sdk';
import {
  validateAssistantDisclosure,
  type NodeDefinitionRegistration,
} from '@pertexo/node-sdk/server';
import {
  CORE_NODE_CATALOG,
  CORE_NODE_DEFINITION_REGISTRATIONS,
} from '@pertexo/nodes-core';
import { registerIntegrationModules } from './integration-modules.js';
import {
  IntegrationRegistryError,
  PlatformNodeDefinitionUnavailableError,
} from './node-catalog.errors.js';

export type PlatformNodeDefinition = NodeDefinitionRegistration;

type PlatformRegistry = ReturnType<typeof registerPlatform>;
let processRegistry:
  | Readonly<{ source: 'built-in' | 'approved'; registry: PlatformRegistry }>
  | undefined;

export function platformRegistry(): PlatformRegistry {
  processRegistry ??= {
    source: 'built-in',
    registry: registerPlatform(INTEGRATION_MODULES),
  };
  return processRegistry.registry;
}

export function installPlatformIntegrations(
  modules?: readonly IntegrationModule[],
): void {
  if (modules === undefined && processRegistry?.source !== 'approved') {
    platformRegistry();
    return;
  }
  if (modules !== undefined && processRegistry === undefined) {
    processRegistry = {
      source: 'approved',
      registry: registerPlatform([...INTEGRATION_MODULES, ...modules]),
    };
    return;
  }
  throw new IntegrationRegistryError('process registry', 'already initialized');
}

function registerPlatform(modules: readonly IntegrationModule[]) {
  const integrations = registerIntegrationModules(modules);
  const integrated = integrations.registrations.map(({ manifest }) => manifest);
  for (const manifest of integrated) {
    assertAttemptOnlyManifest(manifest);
    for (const slot of manifest.connectionRequirements)
      if (integrations.findConnectionSlot(slot) === undefined)
        throw new IntegrationRegistryError('slot reference', slot);
  }
  const definitions = [...CORE_NODE_CATALOG.definitions, ...integrated];
  const operations = new Set(
    integrated.flatMap(({ integration }) =>
      integration === undefined
        ? []
        : [`${integration.providerKey}:${integration.operationKey}`],
    ),
  );
  if (
    definitions.length > NODE_CATALOG_COUNT_LIMITS.definitions ||
    operations.size > NODE_CATALOG_COUNT_LIMITS.integrations ||
    integrations.connectionFormCatalog.length >
      NODE_CATALOG_COUNT_LIMITS.integrations
  )
    throw new IntegrationRegistryError(
      'catalog limit',
      'too many registered definitions, operations or connections',
    );

  const catalog = createNodeCatalog({
    definitions,
    executors: [
      ...CORE_NODE_CATALOG.executors,
      ...integrated.map(executorManifestFor),
    ],
    policies: [...CORE_NODE_CATALOG.policies, ...integrations.policies],
  });
  const registrations = new Map(
    [...CORE_NODE_DEFINITION_REGISTRATIONS, ...integrations.registrations].map(
      (registration) => {
        validateAssistantDisclosure(registration);
        return [
          `${registration.manifest.definition.key}@${String(registration.manifest.definition.version)}`,
          registration,
        ];
      },
    ),
  );
  return { integrations, catalog, registrations };
}

/** Every catalog read resolves the registry selected during process startup. */
export const PLATFORM_NODE_CATALOG: NodeCatalog = Object.freeze({
  get definitions() {
    return platformRegistry().catalog.definitions;
  },
  get executors() {
    return platformRegistry().catalog.executors;
  },
  get policies() {
    return platformRegistry().catalog.policies;
  },
});

/** A definition's schemas and validators, without loading an executor. */
export function resolvePlatformNodeDefinition(
  definitionInput: unknown,
): PlatformNodeDefinition {
  // A malformed identity names no catalog node, so it is as unavailable as an
  // unknown one; drafts may hold keys the catalog's grammar never accepts.
  const identity = definitionIdentitySchema.safeParse(definitionInput);
  if (!identity.success) throw new PlatformNodeDefinitionUnavailableError();
  const { key, version } = identity.data;
  const registration = platformRegistry().registrations.get(
    `${key}@${String(version)}`,
  );
  if (registration === undefined)
    throw new PlatformNodeDefinitionUnavailableError();
  return registration;
}

export function connectionFormCatalog() {
  return platformRegistry().integrations.connectionFormCatalog;
}

export function findConnectionDefinition(
  authType: string,
  providerKey?: string,
) {
  return platformRegistry().integrations.findConnectionDefinition(
    authType,
    providerKey,
  );
}

export function findConnectionLookup(providerKey: string, lookupKey: string) {
  return platformRegistry().integrations.connectionLookup(
    providerKey,
    lookupKey,
  );
}

export function isRegisteredProvider(providerKey: string) {
  return platformRegistry().integrations.isRegisteredProvider(providerKey);
}
