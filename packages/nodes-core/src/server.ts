import {
  createNodeRegistry,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';

import { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
import { CORE_NODE_CATALOG } from './registry.js';
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
