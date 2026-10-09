import {
  createNodeCatalog,
  parseNodeCatalog,
  type NodeCatalog,
} from '@pertexo/node-sdk';
import {
  BASELINE_RUNTIME_POLICIES,
  fail,
  globalPolicies,
  normalizeError,
} from './foundation.js';

export function composeExecutableCatalog(
  nodeCatalogInput: unknown,
): NodeCatalog {
  try {
    const nodeCatalog = parseNodeCatalog(nodeCatalogInput);
    if (nodeCatalog.policies.some(({ key }) => key.startsWith('engine.')))
      fail('node catalog must not declare engine runtime policies');
    return createNodeCatalog({
      definitions: nodeCatalog.definitions,
      executors: nodeCatalog.executors,
      policies: [
        ...nodeCatalog.policies,
        ...globalPolicies(BASELINE_RUNTIME_POLICIES),
      ],
    });
  } catch (error) {
    normalizeError(error);
  }
}
