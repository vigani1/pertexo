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

import type { NodeAttemptRunStore } from './contract.js';

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
    readAttemptOutputs: (
      input: Parameters<NodeAttemptRunStore['readAttemptOutputs']>[0],
    ) => readNodeAttemptOutputs(pool, input),
    listNodeOutcomes: (
      input: Parameters<NodeAttemptRunStore['listNodeOutcomes']>[0],
    ) => listNodeRunOutcomes(pool, input),
    readNodeOutputs: (
      input: Parameters<NodeAttemptRunStore['readNodeOutputs']>[0],
    ) => readNodeRunOutputs(pool, input),
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
