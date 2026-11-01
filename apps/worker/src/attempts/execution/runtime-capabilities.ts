import { createCodeRunnerClient } from '../code/client.js';

import type {
  WorkerNodeRuntimeCapabilityOptions,
  WorkerNodeRuntimeCapabilityDependencies,
  WorkerNodeRuntimeCapabilities,
  CapabilityAssembly,
} from './capability-composition/contract.js';
import {
  assertCapabilityRuntimeOpen,
  closeCapabilityResources,
} from './capability-composition/lifecycle.js';
import { prepareCallbackCapability } from './capability-composition/callbacks.js';
import {
  prepareRunValuesCapability,
  prepareDataTablesCapability,
} from './capability-composition/data.js';
import { prepareCodeCapability } from './capability-composition/code.js';
import { prepareWebhookResponseCapability } from './capability-composition/responses.js';
import { prepareConnectionCapability } from './capability-composition/connections.js';
import { prepareArtifactCapability } from './capability-composition/artifacts.js';

export {
  type WorkerNodeRuntimeCapabilityOptions,
  type WorkerNodeRuntimeCapabilityDependencies,
  type WorkerNodeRuntimeCapabilities,
} from './capability-composition/contract.js';
const DEFAULT_ARTIFACT_RETENTION_MILLIS = 30 * 24 * 60 * 60_000;

export async function createWorkerNodeRuntimeCapabilities(
  options: WorkerNodeRuntimeCapabilityOptions,
  dependencies: WorkerNodeRuntimeCapabilityDependencies = {},
): Promise<WorkerNodeRuntimeCapabilities> {
  const retentionMillis =
    options.artifactRetentionMillis ?? DEFAULT_ARTIFACT_RETENTION_MILLIS;
  const connectionConfigured =
    options.connectionEncryption !== undefined ||
    dependencies.connectionStore !== undefined ||
    dependencies.connectionEncryption !== undefined;
  const artifactConfigured =
    options.artifactStore !== undefined ||
    dependencies.artifactPersistence !== undefined ||
    dependencies.artifactStore !== undefined;
  const codeClient =
    options.codeRunner === undefined
      ? undefined
      : createCodeRunnerClient(options.codeRunner);
  const state: CapabilityAssembly = {
    options,
    dependencies,
    resources: {
      ownedCallbacks: undefined,
      callbackKeys: undefined,
      ownedDataTables: undefined,
      ownedRunValues: undefined,
      ownedWebhookResponses: undefined,
      encryptionRuntime: undefined,
      oauth2Tokens: undefined,
      ownedConnectionStore: undefined,
      ownedArtifactDatabase: undefined,
      ownedArtifactStore: undefined,
      ownedProviderRateLimiter: undefined,
    },
    factories: {},
    lifecycle: { terminal: false },
    retentionMillis,
    codeClient,
  };
  try {
    prepareCallbackCapability(state);
    prepareRunValuesCapability(state);
    prepareDataTablesCapability(state);
    prepareCodeCapability(state);
    prepareWebhookResponseCapability(state);
    if (connectionConfigured) prepareConnectionCapability(state);
    if (artifactConfigured) await prepareArtifactCapability(state);
  } catch (error: unknown) {
    try {
      await closeCapabilityResources(state);
    } catch (cleanupError: unknown) {
      const cleanupFailures =
        cleanupError instanceof AggregateError
          ? (cleanupError.errors as unknown[])
          : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Worker node runtime capability construction failed and cleanup was incomplete',
      );
    }
    throw error;
  }
  return Object.freeze({
    factories: Object.freeze(state.factories),
    checkReadiness: async (): Promise<void> => {
      assertCapabilityRuntimeOpen(state.lifecycle);
      await state.checkArtifactReadiness?.();
      assertCapabilityRuntimeOpen(state.lifecycle);
    },
    checkObjectStore: async (): Promise<void> => {
      await state.checkObjectStore?.();
    },
    close: () => closeCapabilityResources(state),
  });
}
