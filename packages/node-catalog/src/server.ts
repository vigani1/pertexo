import './server-only.js';

import { HTTP_REQUEST_DEFINITION_REGISTRATION } from '@pertexo/integrations';
import {
  createHttpRequestExecutorRegistration,
  createNodeSecureHttpClient,
  type HttpRequestExecutorDependencies,
} from '@pertexo/integrations/server';
import { parseRegistryRelease } from '@pertexo/node-sdk';
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
}>;

export function createPlatformNodeRegistryForRelease(
  releaseInput: unknown,
  dependencies: PlatformNodeRegistryDependencies = {},
): PlatformNodeRegistry {
  const release = parseRegistryRelease(releaseInput);
  if (
    !PLATFORM_REGISTRY_RELEASE_HISTORY.some(
      (supported) =>
        supported.epoch === release.epoch &&
        supported.fingerprint === release.fingerprint,
    )
  )
    throw new Error('Platform compatibility release identity is not supported');

  const definitionRegistrations: readonly NodeDefinitionRegistration[] = [
    ...CORE_NODE_DEFINITION_REGISTRATIONS,
    HTTP_REQUEST_DEFINITION_REGISTRATION,
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

  const httpExecutor = createHttpRequestExecutorRegistration(
    dependencies.httpRequest ?? { httpClient: createNodeSecureHttpClient() },
    'active',
  );
  const executorRegistrations: readonly NodeExecutorRegistration[] = [
    ...CORE_NODE_EXECUTOR_REGISTRATIONS,
    httpExecutor,
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
