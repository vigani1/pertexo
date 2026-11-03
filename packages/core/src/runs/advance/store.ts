import type { Pool } from 'pg';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { saveRunTransition } from './persist/commit.js';
import type {
  RunAdvanceDecision,
  RunAdvanceInput,
  RunAdvanceResult,
  RunAdvanceState,
} from './contract.js';
import {
  auditCoordinatorDeliveryMismatch,
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  DeliveryMismatch,
  validateAuthoritativeAdvanceDelivery,
} from './receipts.repository.js';
import { loadRunForAdvance } from './load/state.repository.js';
import {
  assertCoordinatorNotAborted,
  withCoordinatorWriteClient,
} from './coordinator-transaction.js';

/**
 * Locks the run, reads its state, lets `decide` compute the transition and saves it,
 * all in one transaction. A delivery has no member behind it: its authority is the
 * delivery's own durable identity, so this stays off withWorkspaceAccess.
 */
async function advance(
  pool: Pool,
  input: RunAdvanceInput,
  decide: (state: RunAdvanceState) => Promise<RunAdvanceDecision>,
): Promise<RunAdvanceResult> {
  assertCoordinatorNotAborted(input.signal);
  const workspaceId = input.workspaceId;
  const runId = input.runId;
  const delivery = input.delivery;
  const { signal, traceparent } = input;
  try {
    return await withCoordinatorWriteClient(
      pool,
      workspaceId,
      signal,
      async (client) => {
        await validateAuthoritativeAdvanceDelivery(
          client,
          workspaceId,
          runId,
          delivery,
        );
        const loaded = await loadRunForAdvance(client, {
          workspaceId,
          runId,
        });
        if (loaded.kind !== 'loaded') return loaded;
        assertCoordinatorNotAborted(signal);
        const decision = await decide(loaded.state);
        assertCoordinatorNotAborted(signal);
        if (decision.kind === 'no_change') {
          if (
            (await claimCoordinatorReceipt(client, workspaceId, delivery)) ===
            'new'
          )
            await completeCoordinatorReceipt(client, workspaceId, delivery);
          return Object.freeze({
            kind: 'no_change',
            revision: loaded.row.revision,
          });
        }
        return saveRunTransition(client, {
          delivery,
          pendingFailures: loaded.pendingFailures,
          plan: decision.plan,
          previous: decision.previous,
          row: loaded.row,
          runId,
          ...(traceparent === undefined ? {} : { traceparent }),
          workspaceId,
        });
      },
    );
  } catch (error: unknown) {
    if (error instanceof DeliveryMismatch)
      return auditCoordinatorDeliveryMismatch(
        pool,
        workspaceId,
        delivery,
        signal,
      );
    throw error;
  }
}

export type RunAdvanceStore = ReturnType<typeof createRunAdvanceStore>;

export function createRunAdvanceStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    advance: (
      input: RunAdvanceInput,
      decide: (state: RunAdvanceState) => Promise<RunAdvanceDecision>,
    ) => advance(lease.pool, input, decide),
    close: () => lease.close(),
  });
}
