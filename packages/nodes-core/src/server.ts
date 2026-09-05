import './server-only.js';

import {
  createRegistryReleaseSuccessor,
  parseRegistryRelease,
} from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

import { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
import { CORE_REGISTRY_RELEASE } from './registry.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from './registrations.js';

export { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
export { CORE_NODE_EXECUTOR_REGISTRATIONS } from './registrations.js';

function identityToken(identity: Readonly<{ key: string; version: number }>) {
  return `${identity.key}\u0000${String(identity.version)}`;
}

export interface CoreNodeRegistry {
  readonly compatibility: NodeRegistry['compatibility'];
  readonly historicalCatalog: NodeRegistry['historicalCatalog'];
  readonly dispatchMode: NodeRegistry['dispatchMode'];
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
}

export function createCoreNodeRegistry(): CoreNodeRegistry {
  return createCoreNodeRegistryForRelease(CORE_REGISTRY_RELEASE);
}

export function createCoreNodeRegistryForRelease(
  releaseInput: unknown,
): CoreNodeRegistry {
  const release = parseRegistryRelease(releaseInput);
  if (
    release.epoch === CORE_REGISTRY_RELEASE.epoch &&
    release.fingerprint !== CORE_REGISTRY_RELEASE.fingerprint
  )
    throw new Error('Core compatibility release identity is not supported');
  if (release.epoch !== CORE_REGISTRY_RELEASE.epoch) {
    if (release.epoch !== CORE_REGISTRY_RELEASE.epoch + 1)
      throw new Error('Core compatibility release is not the next successor');
    const successor = createRegistryReleaseSuccessor({
      epoch: release.epoch,
      definitions: release.definitions,
      executors: release.executors,
      policies: release.policies,
      previous: CORE_REGISTRY_RELEASE,
    });
    if (successor.fingerprint !== release.fingerprint)
      throw new Error('Core compatibility release successor changed');
  }
  const definitionsByIdentity = new Map(
    CORE_NODE_DEFINITION_REGISTRATIONS.map((registration) => [
      identityToken(registration.manifest.definition),
      registration,
    ]),
  );
  const releaseDefinitions = release.definitions.map((manifest) => {
    const registration = definitionsByIdentity.get(
      identityToken(manifest.definition),
    );
    if (registration === undefined)
      throw new Error('Core compatibility definition is not implemented');
    return Object.freeze({ ...registration, manifest });
  });
  const executorsByIdentity = new Map(
    CORE_NODE_EXECUTOR_REGISTRATIONS.map((registration) => [
      identityToken(registration.executor),
      registration,
    ]),
  );
  const releaseExecutors = release.executors.map((manifest) => {
    const registration = executorsByIdentity.get(
      identityToken(manifest.executor),
    );
    if (registration === undefined)
      throw new Error('Core compatibility executor is not implemented');
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
