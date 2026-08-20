import './server-only.js';

import {
  createNodeRegistry,
  type NodeDefinitionRegistration,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

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

const definitions: readonly NodeDefinitionRegistration[] = [
  {
    manifest: CORE_MANUAL_MANIFEST,
    configSchema: CORE_MANUAL_CONFIG_SCHEMA,
    inputSchema: CORE_MANUAL_INPUT_SCHEMA,
    outputSchema: CORE_MANUAL_OUTPUT_SCHEMA,
  },
  {
    manifest: CORE_SET_MANIFEST,
    configSchema: CORE_SET_CONFIG_SCHEMA,
    inputSchema: CORE_SET_INPUT_SCHEMA,
    outputSchema: CORE_SET_OUTPUT_SCHEMA,
  },
  {
    manifest: CORE_TERMINATE_MANIFEST,
    configSchema: CORE_TERMINATE_CONFIG_SCHEMA,
    inputSchema: CORE_TERMINATE_INPUT_SCHEMA,
    outputSchema: CORE_TERMINATE_OUTPUT_SCHEMA,
  },
];

export interface CoreNodeRegistry {
  readonly compatibility: NodeRegistry['compatibility'];
  readonly historicalCatalog: NodeRegistry['historicalCatalog'];
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
}

export function createCoreNodeRegistry(): CoreNodeRegistry {
  const registry = createNodeRegistry({
    release: CORE_REGISTRY_RELEASE,
    definitions,
    executors: [coreManualExecutor, coreSetExecutor, coreTerminateExecutor],
  });
  return Object.freeze({
    compatibility: registry.compatibility,
    historicalCatalog: registry.historicalCatalog,
    execute: registry.execute,
  });
}
