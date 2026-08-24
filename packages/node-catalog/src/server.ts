import './server-only.js';

import {
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
} from '@pertexo/integrations';
import {
  createHttpRequestExecutorRegistration,
  createNodeSecureHttpClient,
  type HttpRequestExecutorDependencies,
  type HttpRequestExecutorTelemetry,
  createSlackClient,
  createSlackSendMessageExecutorRegistration,
  type SlackSendMessageExecutorDependencies,
  type SlackSendMessageExecutorTelemetry,
} from '@pertexo/integrations/server';
import {
  definitionIdentitySchema,
  parseRegistryRelease,
  type DefinitionIdentity,
} from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  type NodeDefinitionRegistration,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeExecutorRegistration,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';
import {
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_NODE_EXECUTOR_REGISTRATIONS,
} from '@pertexo/nodes-core/server';

import { PLATFORM_REGISTRY_RELEASE_HISTORY } from './registry.js';

function identityToken(identity: Readonly<{ key: string; version: number }>) {
  return `${identity.key}\u0000${String(identity.version)}`;
}

export type PlatformNodeRegistry = Readonly<{
  compatibility: NodeRegistry['compatibility'];
  historicalCatalog: NodeRegistry['historicalCatalog'];
  dispatchMode: NodeRegistry['dispatchMode'];
  execute(request: NodeExecutionRequest): Promise<NodeExecutionResult>;
}>;

export type PlatformNodeRegistryDependencies = Readonly<{
  httpRequest?: HttpRequestExecutorDependencies;
  httpRequestTelemetry?: HttpRequestExecutorTelemetry;
  slackSendMessage?: SlackSendMessageExecutorDependencies;
  slackSendMessageTelemetry?: SlackSendMessageExecutorTelemetry;
}>;

export type PlatformNodeDefinition = NodeDefinitionRegistration;

function supportedRelease(releaseInput: unknown) {
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

/** Resolve only browser-safe schemas/metadata; this seam cannot execute a node. */
export function resolvePlatformNodeDefinitionForRelease(
  releaseInput: unknown,
  definitionInput: DefinitionIdentity,
): PlatformNodeDefinition {
  const release = supportedRelease(releaseInput);
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
  ].find(
    (candidate) =>
      candidate.manifest.definition.key === definition.key &&
      candidate.manifest.definition.version === definition.version,
  );
  if (manifest === undefined || registration === undefined)
    throw new Error('Platform compatibility definition is not implemented');
  return Object.freeze({ ...registration, manifest });
}

export function createPlatformNodeRegistryForRelease(
  releaseInput: unknown,
  dependencies: PlatformNodeRegistryDependencies = {},
): PlatformNodeRegistry {
  const release = supportedRelease(releaseInput);

  const definitionRegistrations: readonly NodeDefinitionRegistration[] = [
    ...CORE_NODE_DEFINITION_REGISTRATIONS,
    HTTP_REQUEST_DEFINITION_REGISTRATION,
    SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  ];
  const definitionsByIdentity = new Map(
    definitionRegistrations.map((registration) => [
      identityToken(registration.manifest.definition),
      registration,
    ]),
  );
  const releaseDefinitions = release.definitions.map((manifest) => {
    const registration = definitionsByIdentity.get(
      identityToken(manifest.definition),
    );
    if (registration === undefined)
      throw new Error('Platform compatibility definition is not implemented');
    return Object.freeze({ ...registration, manifest });
  });

  const httpRequestDependencies = dependencies.httpRequest ?? {
    httpClient: createNodeSecureHttpClient(),
  };
  const httpExecutor = createHttpRequestExecutorRegistration(
    {
      ...httpRequestDependencies,
      ...(dependencies.httpRequestTelemetry === undefined
        ? {}
        : { telemetry: dependencies.httpRequestTelemetry }),
    },
    'active',
  );
  const slackDependencies = dependencies.slackSendMessage ?? {
    client: createSlackClient(createNodeSecureHttpClient()),
  };
  const slackExecutor = createSlackSendMessageExecutorRegistration(
    {
      ...slackDependencies,
      ...(dependencies.slackSendMessageTelemetry === undefined
        ? {}
        : { telemetry: dependencies.slackSendMessageTelemetry }),
    },
    'active',
  );
  const executorRegistrations: readonly NodeExecutorRegistration[] = [
    ...CORE_NODE_EXECUTOR_REGISTRATIONS,
    httpExecutor,
    slackExecutor,
  ];
  const executorsByIdentity = new Map(
    executorRegistrations.map((registration) => [
      identityToken(registration.executor),
      registration,
    ]),
  );
  const releaseExecutors = release.executors.map((manifest) => {
    const registration = executorsByIdentity.get(
      identityToken(manifest.executor),
    );
    if (registration === undefined)
      throw new Error('Platform compatibility executor is not implemented');
    return Object.freeze({ ...manifest, execute: registration.execute });
  });
  const registry = createNodeRegistry({
    release,
    definitions: releaseDefinitions,
    executors: releaseExecutors,
  });
  return Object.freeze({
    compatibility: registry.compatibility,
    historicalCatalog: registry.historicalCatalog,
    dispatchMode: registry.dispatchMode,
    execute: registry.execute,
  });
}
