import {
  createRegistryRelease,
  parseRegistryRelease,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  BASELINE_RUNTIME_POLICIES,
  fail,
  globalPolicies,
  normalizeError,
} from './foundation.js';

export function composeExecutableCompatibilityRelease(
  nodeReleaseInput: unknown,
): RegistryRelease {
  try {
    const nodeRelease = parseRegistryRelease(nodeReleaseInput);
    if (nodeRelease.policies.some(({ key }) => key.startsWith('engine.')))
      fail('node release must not declare engine runtime policies');
    return createRegistryRelease({
      epoch: nodeRelease.epoch,
      definitions: nodeRelease.definitions,
      executors: nodeRelease.executors,
      policies: [
        ...nodeRelease.policies,
        ...globalPolicies(BASELINE_RUNTIME_POLICIES),
      ],
    });
  } catch (error) {
    normalizeError(error);
  }
}
