import {
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
} from '@pertexo/integrations';
import { definitionIdentitySchema, type NodeManifest } from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { CORE_NODE_DEFINITION_REGISTRATIONS } from '@pertexo/nodes-core';

import { PLATFORM_NODE_CATALOG } from './registry.js';

export type PlatformNodeDefinition = NodeDefinitionRegistration;

/**
 * The metadata exposed to browser clients.  Runtime schemas are retained as
 * JSON documents, while executor identities, ABI details, and policy
 * references remain private runtime implementation details.
 */
export type PlatformNodeDefinitionBrowserProjection = Readonly<{
  readonly definition: Readonly<{ key: string; version: number }>;
  readonly family: NodeDefinitionRegistration['manifest']['family'];
  readonly configVersion: number;
  readonly configSchema: NodeDefinitionRegistration['manifest']['configSchema'];
  readonly inputSchema: NodeDefinitionRegistration['manifest']['inputSchema'];
  readonly outputSchema: NodeDefinitionRegistration['manifest']['outputSchema'];
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
  readonly retryClass: NodeDefinitionRegistration['manifest']['retryClass'];
  readonly resourceClass: NodeDefinitionRegistration['manifest']['resourceClass'];
  readonly capabilities: readonly string[];
}>;

export type PlatformNodeDefinitionBrowserCatalog = Readonly<{
  readonly schemaVersion: 1;
  readonly definitions: readonly PlatformNodeDefinitionBrowserProjection[];
}>;

export const PLATFORM_NODE_DEFINITION_REGISTRATIONS = Object.freeze([
  ...CORE_NODE_DEFINITION_REGISTRATIONS,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
] as const satisfies readonly NodeDefinitionRegistration[]);

const PLATFORM_NODE_DEFINITION_REGISTRATIONS_BY_IDENTITY = new Map(
  PLATFORM_NODE_DEFINITION_REGISTRATIONS.map((registration) => [
    platformIdentityToken(registration.manifest.definition),
    registration,
  ]),
);

function platformIdentityToken(
  identity: Readonly<{ key: string; version: number }>,
): string {
  return `${identity.key}\u0000${String(identity.version)}`;
}

/**
 * Resolve a definition's schemas and validators without loading an executor.
 * HTTP discovery uses the narrower browser projection below.
 */
export function resolvePlatformNodeDefinition(
  definitionInput: unknown,
): PlatformNodeDefinition {
  const definition = definitionIdentitySchema.parse(definitionInput);
  const manifest = PLATFORM_NODE_CATALOG.definitions.find(
    (candidate) =>
      candidate.definition.key === definition.key &&
      candidate.definition.version === definition.version,
  );
  if (manifest === undefined)
    throw new Error('Platform node definition is not implemented');
  return resolveRegisteredPlatformManifest(manifest);
}

function resolveRegisteredPlatformManifest(
  manifest: NodeManifest,
): PlatformNodeDefinition {
  const registration = PLATFORM_NODE_DEFINITION_REGISTRATIONS_BY_IDENTITY.get(
    platformIdentityToken(manifest.definition),
  );
  if (registration === undefined)
    throw new Error('Platform node definition is not implemented');
  return Object.freeze({ ...registration, manifest });
}

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
    .map((manifest) => {
      const registration = resolveRegisteredPlatformManifest(manifest);
      const projection = registration.manifest;
      return Object.freeze({
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
      });
    });
  return Object.freeze({
    schemaVersion: 1,
    definitions: Object.freeze(definitions),
  });
}
