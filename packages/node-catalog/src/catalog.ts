import {
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_POLICY,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_POLICY,
} from '@pertexo/integrations';
import {
  createNodeCatalog,
  definitionIdentitySchema,
  executorManifestFor,
} from '@pertexo/node-sdk';
import type { NodeDefinitionRegistration } from '@pertexo/node-sdk/server';
import {
  CORE_NODE_CATALOG,
  CORE_NODE_DEFINITION_REGISTRATIONS,
} from '@pertexo/nodes-core';

export type PlatformNodeDefinition = NodeDefinitionRegistration;

const INTEGRATION_REGISTRATIONS = [
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
];
const INTEGRATION_MANIFESTS = INTEGRATION_REGISTRATIONS.map(
  ({ manifest }) => manifest,
);

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
    HTTP_REQUEST_NETWORK_POLICY,
    HTTP_REQUEST_VALUE_POLICY,
    SLACK_SEND_MESSAGE_POLICY,
    EMAIL_SEND_NOTIFICATION_POLICY,
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
  const { key, version } = definitionIdentitySchema.parse(definitionInput);
  const registration = REGISTRATIONS_BY_IDENTITY.get(
    `${key}@${String(version)}`,
  );
  if (registration === undefined)
    throw new Error('Platform node definition is not implemented');
  return registration;
}
