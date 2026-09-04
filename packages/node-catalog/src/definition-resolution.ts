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

export type PlatformNodeDefinition = NodeDefinitionRegistration;

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

/** Resolve browser-safe schemas and metadata without loading any executor. */
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
  const registration = [
    ...CORE_NODE_DEFINITION_REGISTRATIONS,
    HTTP_REQUEST_DEFINITION_REGISTRATION,
    SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
    EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  ].find(
    (candidate) =>
      candidate.manifest.definition.key === definition.key &&
      candidate.manifest.definition.version === definition.version,
  );
  if (manifest === undefined || registration === undefined)
    throw new Error('Platform compatibility definition is not implemented');
  return Object.freeze({ ...registration, manifest });
}
