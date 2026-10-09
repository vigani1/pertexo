import type { NodeManifest } from '@pertexo/node-sdk';

import { PLATFORM_NODE_CATALOG } from './catalog.js';

/**
 * The metadata exposed to browser clients.  Runtime schemas are retained as
 * JSON documents, while executor identities, ABI details, and policy
 * references remain private runtime implementation details.
 */
export type PlatformNodeDefinitionBrowserProjection = Readonly<{
  readonly definition: Readonly<{ key: string; version: number }>;
  readonly family: NodeManifest['family'];
  readonly configVersion: number;
  readonly configSchema: NodeManifest['configSchema'];
  readonly inputSchema: NodeManifest['inputSchema'];
  readonly outputSchema: NodeManifest['outputSchema'];
  readonly ports: Readonly<{
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
  }>;
  readonly credentialRequirements: readonly string[];
  readonly connectionRequirements: readonly string[];
  readonly integration?: Readonly<{
    readonly providerKey: string;
    readonly operationKey: string;
  }>;
  readonly retryClass: NodeManifest['retryClass'];
  readonly resourceClass: NodeManifest['resourceClass'];
  readonly capabilities: readonly string[];
}>;

export type PlatformNodeDefinitionBrowserCatalog = Readonly<{
  readonly schemaVersion: 1;
  readonly definitions: readonly PlatformNodeDefinitionBrowserProjection[];
}>;

function compareDefinitionIdentity(
  left: Readonly<{ key: string; version: number }>,
  right: Readonly<{ key: string; version: number }>,
): number {
  return left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : left.version - right.version;
}

/** Every definition in the served catalog, without executor or policy details. */
export function platformBrowserNodeDefinitionCatalog(): PlatformNodeDefinitionBrowserCatalog {
  const definitions = [...PLATFORM_NODE_CATALOG.definitions]
    .sort((left, right) =>
      compareDefinitionIdentity(left.definition, right.definition),
    )
    .map((projection) =>
      Object.freeze({
        definition: Object.freeze({ ...projection.definition }),
        family: projection.family,
        configVersion: projection.configVersion,
        configSchema: projection.configSchema,
        inputSchema: projection.inputSchema,
        outputSchema: projection.outputSchema,
        ports: Object.freeze({
          inputs: Object.freeze([...projection.ports.inputs]),
          outputs: Object.freeze([...projection.ports.outputs]),
        }),
        credentialRequirements: Object.freeze([
          ...projection.credentialRequirements,
        ]),
        connectionRequirements: Object.freeze([
          ...projection.connectionRequirements,
        ]),
        ...(projection.integration === undefined
          ? {}
          : { integration: Object.freeze({ ...projection.integration }) }),
        retryClass: projection.retryClass,
        resourceClass: projection.resourceClass,
        capabilities: Object.freeze([...projection.capabilities]),
      }),
    );
  return Object.freeze({
    schemaVersion: 1,
    definitions: Object.freeze(definitions),
  });
}
