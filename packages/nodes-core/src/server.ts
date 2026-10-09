import './server-only.js';

import {
  createNodeRegistry,
  bindRegistryRelease,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

import { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
import { CORE_REGISTRY_RELEASE } from './registry.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from './registrations.js';

export { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
export { CORE_NODE_EXECUTOR_REGISTRATIONS } from './registrations.js';

export interface CoreNodeRegistry {
  readonly compatibility: NodeRegistry['compatibility'];
  readonly historicalCatalog: NodeRegistry['historicalCatalog'];
  readonly dispatchMode: NodeRegistry['dispatchMode'];
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
}

export function createCoreNodeRegistry(): CoreNodeRegistry {
  const registry = createNodeRegistry(
    bindRegistryRelease({
      release: CORE_REGISTRY_RELEASE,
      definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
      executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
    }),
  );
  return Object.freeze({
    compatibility: registry.compatibility,
    historicalCatalog: registry.historicalCatalog,
    dispatchMode: registry.dispatchMode,
    execute: registry.execute,
  });
}
