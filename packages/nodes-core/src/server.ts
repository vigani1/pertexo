import './server-only.js';

import {
  createRegistryReleaseSuccessor,
  parseRegistryRelease,
} from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  type NodeDefinitionRegistration,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

import { coreConditionExecutor } from './condition/executor.js';
import {
  CORE_CONDITION_CONFIG_SCHEMA,
  CORE_CONDITION_INPUT_SCHEMA,
  CORE_CONDITION_MANIFEST,
  CORE_CONDITION_OUTPUT_SCHEMA,
} from './condition/index.js';
import { coreManualExecutor } from './manual/executor.js';
import {
  CORE_MANUAL_CONFIG_SCHEMA,
  CORE_MANUAL_INPUT_SCHEMA,
  CORE_MANUAL_MANIFEST,
  CORE_MANUAL_OUTPUT_SCHEMA,
} from './manual/index.js';
import { CORE_REGISTRY_RELEASE } from './registry.js';
import { coreSetExecutor } from './set/executor.js';
import {
  CORE_SET_CONFIG_SCHEMA,
  CORE_SET_INPUT_SCHEMA,
  CORE_SET_MANIFEST,
  CORE_SET_OUTPUT_SCHEMA,
} from './set/index.js';
import { coreTerminateExecutor } from './terminate/executor.js';
import {
  CORE_TERMINATE_CONFIG_SCHEMA,
  CORE_TERMINATE_INPUT_SCHEMA,
  CORE_TERMINATE_MANIFEST,
  CORE_TERMINATE_OUTPUT_SCHEMA,
} from './terminate/index.js';

export const CORE_NODE_DEFINITION_REGISTRATIONS: readonly NodeDefinitionRegistration[] =
  Object.freeze([
    Object.freeze({
      manifest: CORE_CONDITION_MANIFEST,
      configSchema: CORE_CONDITION_CONFIG_SCHEMA,
      inputSchema: CORE_CONDITION_INPUT_SCHEMA,
      outputSchema: CORE_CONDITION_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_MANUAL_MANIFEST,
      configSchema: CORE_MANUAL_CONFIG_SCHEMA,
      inputSchema: CORE_MANUAL_INPUT_SCHEMA,
      outputSchema: CORE_MANUAL_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_SET_MANIFEST,
      configSchema: CORE_SET_CONFIG_SCHEMA,
      inputSchema: CORE_SET_INPUT_SCHEMA,
      outputSchema: CORE_SET_OUTPUT_SCHEMA,
    }),
    Object.freeze({
      manifest: CORE_TERMINATE_MANIFEST,
      configSchema: CORE_TERMINATE_CONFIG_SCHEMA,
      inputSchema: CORE_TERMINATE_INPUT_SCHEMA,
      outputSchema: CORE_TERMINATE_OUTPUT_SCHEMA,
    }),
  ]);

export const CORE_NODE_EXECUTOR_REGISTRATIONS = Object.freeze([
  coreConditionExecutor,
  coreManualExecutor,
  coreSetExecutor,
  coreTerminateExecutor,
] as const);

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
