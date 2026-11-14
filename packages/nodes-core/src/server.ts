import {
  createNodeRegistry,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

import { CORE_NODE_DEFINITION_REGISTRATIONS } from './catalog/definition-registrations.js';
import { CORE_NODE_CATALOG } from './catalog/core-node-catalog.js';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from './catalog/executor-registrations.js';

export { CORE_NODE_DEFINITION_REGISTRATIONS } from './catalog/definition-registrations.js';
export { CORE_NODE_EXECUTOR_REGISTRATIONS } from './catalog/executor-registrations.js';

export function createCoreNodeRegistry(): NodeRegistry {
  return createNodeRegistry({
    catalog: CORE_NODE_CATALOG,
    definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
    executors: CORE_NODE_EXECUTOR_REGISTRATIONS,
  });
}

export { UTILITY_ERROR_CODE } from './data/utilities/utility-result.js';
export { FILE_CREATION_ERROR_CODE } from './data/create-file/create-file.errors.js';
