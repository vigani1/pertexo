import { acquireDatabasePool } from '../../platform/database-runtime.js';
import type { DatabaseRuntime } from '../../platform/database-runtime.js';

import type { DatabaseConfig } from '../../config.js';
import { claimNodeAttemptDelivery } from './node-attempt-run-store-claim.js';
import { completeNodeAttempt } from './node-attempt-run-store-completion.js';
import { markNodeAttemptDispatched } from './node-attempt-run-store-dispatch.js';
import { heartbeatNodeAttempt } from './node-attempt-run-store-heartbeat.js';
import { recordNodeAttemptInput } from './node-attempt-run-store-input-record.js';
import {
  recordWorkflowCallDeclarationInput,
  readWorkflowCallDeclarationInput,
} from './node-attempt-call-input-record.js';
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
  NodeAttemptInputs,
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
    markDispatched: (
      input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
    ) => markNodeAttemptDispatched(pool, input),
    heartbeat: (input: Parameters<NodeAttemptRunStore['heartbeat']>[0]) =>
      heartbeatNodeAttempt(pool, input),
    recordInput: (
      input: Parameters<NonNullable<NodeAttemptRunStore['recordInput']>>[0],
    ) => recordNodeAttemptInput(pool, input),
    recordCallDeclarationInput: (
      input: Parameters<
        NonNullable<NodeAttemptRunStore['recordCallDeclarationInput']>
      >[0],
    ) => recordWorkflowCallDeclarationInput(pool, input),
    readCallDeclarationInput: (
      input: Parameters<
        NonNullable<NodeAttemptRunStore['readCallDeclarationInput']>
      >[0],
    ) => readWorkflowCallDeclarationInput(pool, input),
    complete: (input: Parameters<NodeAttemptRunStore['complete']>[0]) =>
      completeNodeAttempt(pool, input),
    completeCallDeclaration: (
      input: Parameters<
        NonNullable<NodeAttemptRunStore['completeCallDeclaration']>
      >[0],
    ) =>
      completeNodeAttempt(
        pool,
        { ...input, outcome: { status: 'succeeded', output: null } },
        'workflow_call_input_alias',
      ),
    close: () => lease.close(),
  });
}
