import {
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
} from '@pertexo/integrations';
import {
  definitionIdentitySchema,
  parseRegistryRelease,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import { CORE_NODE_DEFINITION_REGISTRATIONS } from '@pertexo/nodes-core';

import { PLATFORM_REGISTRY_RELEASE_HISTORY } from './registry.js';
import {
  platformServingRegistryRelease,
  type PlatformReleaseCohort,
} from './registry.js';

export type PlatformNodeDefinition = NodeDefinitionRegistration;

/**
 * The metadata exposed to browser clients.  Runtime schemas are retained as
 * JSON documents, while executor identities, ABI details, and policy
 * references remain private runtime implementation details.
 */
export type PlatformNodeDefinitionBrowserProjection = Readonly<{
  readonly schemaVersion: 1 | 2;
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
  readonly lifecycle: NodeDefinitionRegistration['manifest']['lifecycle'];
  readonly available: boolean;
  readonly publishable: boolean;
}>;

export type PlatformNodeDefinitionBrowserCatalog = Readonly<{
  readonly schemaVersion: 1;
  readonly release: Readonly<{
    readonly epoch: number;
    readonly fingerprint: string;
  }>;
  readonly definitions: readonly PlatformNodeDefinitionBrowserProjection[];
}>;

export const PLATFORM_NODE_DEFINITION_REGISTRATIONS = Object.freeze([
  ...CORE_NODE_DEFINITION_REGISTRATIONS,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
] as const satisfies readonly NodeDefinitionRegistration[]);

export function platformIdentityToken(
  identity: Readonly<{ key: string; version: number }>,
): string {
  return `${identity.key}\u0000${String(identity.version)}`;
}

export function parseSupportedPlatformRelease(releaseInput: unknown) {
  const release = parseRegistryRelease(releaseInput);
  if (
    !PLATFORM_REGISTRY_RELEASE_HISTORY.some(
      (supported) =>
        supported.epoch === release.epoch &&
        supported.fingerprint === release.fingerprint,
    )
  )
    throw new Error('Platform compatibility release identity is not supported');
  return release;
}

/**
 * Resolve definition schemas, validators, and compatibility metadata without
 * loading an executor. HTTP discovery uses the narrower projection below;
 * compatibility identities returned by this resolver are not HTTP response fields.
 */
export function resolvePlatformNodeDefinitionForRelease(
  releaseInput: unknown,
  definitionInput: unknown,
): PlatformNodeDefinition {
  const release = parseSupportedPlatformRelease(releaseInput);
  const definition = definitionIdentitySchema.parse(definitionInput);
  const manifest = release.definitions.find(
    (candidate) =>
      candidate.definition.key === definition.key &&
      candidate.definition.version === definition.version,
  );
  const registration = PLATFORM_NODE_DEFINITION_REGISTRATIONS.find(
    (candidate) =>
      candidate.manifest.definition.key === definition.key &&
      candidate.manifest.definition.version === definition.version,
  );
  if (manifest === undefined || registration === undefined)
    throw new Error('Platform compatibility definition is not implemented');
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

/**
 * Return only release-backed definitions that clients may use or publish.
 * Staged, migration-required, and retired definitions are intentionally not
 * surfaced.  The active-executor check prevents a definition from appearing
 * available while its release is still staged.
 */
export function platformBrowserNodeDefinitionCatalog(
  cohort: PlatformReleaseCohort,
): PlatformNodeDefinitionBrowserCatalog {
  const release = platformServingRegistryRelease(cohort);
  const activeExecutors = new Set(
    release.executors
      .filter(({ lifecycle }) => lifecycle === 'active')
      .map(({ executor }) => platformIdentityToken(executor)),
  );
  const definitions = release.definitions
    .filter((manifest) => {
      const executorIsActive = activeExecutors.has(
        platformIdentityToken(manifest.executor),
      );
      return (
        executorIsActive &&
        (manifest.lifecycle === 'active' || manifest.lifecycle === 'deprecated')
      );
    })
    .sort((left, right) =>
      compareDefinitionIdentity(left.definition, right.definition),
    )
    .map((manifest) => {
      const registration = resolvePlatformNodeDefinitionForRelease(
        release,
        manifest.definition,
      );
      const projection = registration.manifest;
      return Object.freeze({
        schemaVersion: projection.schemaVersion,
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
        lifecycle: projection.lifecycle,
        available: projection.lifecycle === 'active',
        publishable:
          projection.lifecycle === 'active' ||
          projection.lifecycle === 'deprecated',
      });
    });
  return Object.freeze({
    schemaVersion: 1,
    release: Object.freeze({
      epoch: release.epoch,
      fingerprint: release.fingerprint,
    }),
    definitions: Object.freeze(definitions),
  });
}
