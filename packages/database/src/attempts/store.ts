import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';

import type { DatabaseConfig } from '../config.js';
import { claimNodeAttemptDelivery } from './claim.js';
import { completeNodeAttempt } from './completion/complete.js';
import { markNodeAttemptDispatched } from './dispatch.js';
import { heartbeatNodeAttempt } from './heartbeat.js';
import { recordNodeAttemptInput } from './input-record.js';
import {
  loadNodeAttemptInputs,
  readNodeAttemptLoopDeclaration,
} from './inputs.js';

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
  type NodeAttemptLoopDeclaration,
  type NodeAttemptStoredInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from './contract.js';

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
  NodeAttemptLoopDeclaration,
  NodeAttemptStoredInputs,
  NodeAttemptLease,
  NodeAttemptRunStore,
};

export function createNodeAttemptRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): NodeAttemptRunStore {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    claimDelivery: (
      input: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
    ) => claimNodeAttemptDelivery(pool, input),
    loadInputs: (input: Parameters<NodeAttemptRunStore['loadInputs']>[0]) =>
      loadNodeAttemptInputs(pool, input),
    readLoopDeclaration: (
      input: Parameters<NodeAttemptRunStore['readLoopDeclaration']>[0],
    ) => readNodeAttemptLoopDeclaration(pool, input),
    markDispatched: (
      input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
    ) => markNodeAttemptDispatched(pool, input),
    heartbeat: (input: Parameters<NodeAttemptRunStore['heartbeat']>[0]) =>
      heartbeatNodeAttempt(pool, input),
    recordInput: (
      input: Parameters<NonNullable<NodeAttemptRunStore['recordInput']>>[0],
    ) => recordNodeAttemptInput(pool, input),
    complete: (input: Parameters<NodeAttemptRunStore['complete']>[0]) =>
      completeNodeAttempt(pool, input),
    close: () => lease.close(),
  });
}
