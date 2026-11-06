import {
  createNodeRegistry,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

import { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
import { CORE_NODE_CATALOG } from './core-node-catalog.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from './registrations.js';

export { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
export { CORE_NODE_EXECUTOR_REGISTRATIONS } from './registrations.js';

export function createCoreNodeRegistry(): NodeRegistry {
  return createNodeRegistry({
    catalog: CORE_NODE_CATALOG,
    definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
    executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
  });
}

export { UTILITY_ERROR_CODE } from './data/utilities/result.js';
export { FILE_CREATION_ERROR_CODE } from './data/create-file/failure.js';
