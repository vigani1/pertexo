import {
  NODE_JSON_LIMITS,
  type PolicyReference,
  type NodeCatalog,
} from '@pertexo/node-sdk';
import type { ExecutableRuntimePolicies } from './workflow-executable.js';
import { sameIdentity, token } from './definition-identity.js';
import { fail } from './executable-errors.js';
export const BASELINE_RUNTIME_POLICIES = Object.freeze({
  scheduler: Object.freeze({ key: 'engine.scheduler', version: 1 }),
  checkpoint: Object.freeze({ key: 'engine.checkpoint', version: 1 }),
  retry: Object.freeze({ key: 'engine.retry', version: 1 }),
  timeout: Object.freeze({ key: 'engine.timeout', version: 1 }),
  cancellation: Object.freeze({ key: 'engine.cancellation', version: 1 }),
});
/**
 * An executable holds the whole graph, so its member limit is sized for the
 * graph's node limit rather than for one node's input or output.
 */
export const WORKFLOW_EXECUTABLE_LIMITS = Object.freeze({
  bytes: NODE_JSON_LIMITS.bytes,
  depth: NODE_JSON_LIMITS.depth,
  members: 100_000,
});

export function globalPolicies(
  policies: ExecutableRuntimePolicies,
): readonly PolicyReference[] {
  return [
    policies.scheduler,
    policies.checkpoint,
    policies.retry,
    policies.timeout,
    policies.cancellation,
  ];
}

export function validateGlobals(
  policies: ExecutableRuntimePolicies,
  catalog: NodeCatalog,
): void {
  const selected = globalPolicies(policies);
  const expected = globalPolicies(BASELINE_RUNTIME_POLICIES);
  if (
    !selected.every((value, index) => {
      const expectedValue = expected[index];
      return expectedValue !== undefined && sameIdentity(value, expectedValue);
    }) ||
    new Set(selected.map(token)).size !== selected.length
  )
    fail('runtime policy selection is not baseline policy v1');
  const available = new Set(catalog.policies.map(token));
  if (!selected.every((value) => available.has(token(value))))
    fail('node catalog is missing a runtime policy');
}
