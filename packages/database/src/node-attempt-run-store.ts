import { createDatabasePool } from './postgres-telemetry.js';

import type { DatabaseConfig } from './config.js';
import { claimNodeAttemptDelivery } from './node-attempt-run-store-claim.js';
import { completeNodeAttempt } from './node-attempt-run-store-completion.js';
import { markNodeAttemptDispatched } from './node-attempt-run-store-dispatch.js';
import { heartbeatNodeAttempt } from './node-attempt-run-store-heartbeat.js';
import { loadNodeAttemptInputs } from './node-attempt-run-store-inputs.js';

import {
  NodeAttemptConnectionFenceError,
  NodeAttemptControlActiveError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  type CompleteNodeAttemptResult,
  type NodeAttemptClaimResult,
  type NodeAttemptCompletion,
  type NodeAttemptDelivery,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';

export {
  NodeAttemptConnectionFenceError,
  NodeAttemptControlActiveError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
};
export type {
  CompleteNodeAttemptResult,
  NodeAttemptClaimResult,
  NodeAttemptCompletion,
  NodeAttemptDelivery,
  NodeAttemptInputs,
  NodeAttemptLease,
  NodeAttemptRunStore,
};

export function createNodeAttemptRunStore(
  config: DatabaseConfig,
): NodeAttemptRunStore {
  const pool = createDatabasePool(config);
  return Object.freeze({
    claimDelivery: (
      input: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
    ) => claimNodeAttemptDelivery(pool, input),
    loadInputs: (input: Parameters<NodeAttemptRunStore['loadInputs']>[0]) =>
      loadNodeAttemptInputs(pool, input),
    markDispatched: (
      input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
    ) => markNodeAttemptDispatched(pool, input),
    heartbeat: (input: Parameters<NodeAttemptRunStore['heartbeat']>[0]) =>
      heartbeatNodeAttempt(pool, input),
    complete: (input: Parameters<NodeAttemptRunStore['complete']>[0]) =>
      completeNodeAttempt(pool, input),
    close: async (): Promise<void> => pool.end(),
  });
}
