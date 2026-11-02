import { acquireDatabasePool } from '@pertexo/database/platform';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';

import { claimNodeAttemptDelivery } from './leases/claim.js';
import { completeNodeAttempt } from './completion/complete.js';
import { markNodeAttemptDispatched } from './dispatch/mark.js';
import { heartbeatNodeAttempt } from './leases/heartbeat.js';
import { recordNodeAttemptInput } from './inputs/record.js';
import { loadNodeAttemptInputs } from './inputs/load.js';
import {
  readNodeAttemptLoopDeclaration,
  readNodeAttemptOutputs,
  listNodeRunOutcomes,
  readNodeRunOutputs,
} from './outputs.queries.js';
import type {
  ClaimDeliveryInput,
  CompleteAttemptInput,
  HeartbeatInput,
  ListNodeOutcomesInput,
  LoadInputsInput,
  MarkDispatchedInput,
  ReadAttemptOutputsInput,
  ReadLoopDeclarationInput,
  ReadNodeOutputsInput,
  RecordInputInput,
} from './contract.js';

/**
 * Every flow here is the worker holding a lease, with no member behind it, so it
 * stays off `withWorkspaceAccess`: the lease's fence is the authority.
 */
export function createNodeAttemptRunStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    claimDelivery: (input: ClaimDeliveryInput) =>
      claimNodeAttemptDelivery(pool, input),
    loadInputs: (input: LoadInputsInput) => loadNodeAttemptInputs(pool, input),
    readLoopDeclaration: (input: ReadLoopDeclarationInput) =>
      readNodeAttemptLoopDeclaration(pool, input),
    readAttemptOutputs: (input: ReadAttemptOutputsInput) =>
      readNodeAttemptOutputs(pool, input),
    listNodeOutcomes: (input: ListNodeOutcomesInput) =>
      listNodeRunOutcomes(pool, input),
    readNodeOutputs: (input: ReadNodeOutputsInput) =>
      readNodeRunOutputs(pool, input),
    markDispatched: (input: MarkDispatchedInput) =>
      markNodeAttemptDispatched(pool, input),
    heartbeat: (input: HeartbeatInput) => heartbeatNodeAttempt(pool, input),
    /**
     * Records the input the attempt's executor is about to receive (ADR 052).
     * Diagnostic: it records nothing, and never throws, when the lease is gone
     * or the input is over the inline bound.
     */
    recordInput: (input: RecordInputInput) =>
      recordNodeAttemptInput(pool, input),
    complete: (input: CompleteAttemptInput) => completeNodeAttempt(pool, input),
    close: () => lease.close(),
  });
}
