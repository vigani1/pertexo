import type { Pool } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { saveRunTransition } from './commit.js';
import {
  coordinatorDeliverySchema,
  coordinatorIdentitySchema,
  type RunAdvanceDecision,
  type RunAdvanceInput,
  type RunAdvanceResult,
  type RunAdvanceState,
  type RunAdvanceStore,
} from './contract.js';
import {
  auditCoordinatorDeliveryMismatch,
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
  DeliveryMismatch,
  validateAuthoritativeAdvanceDelivery,
} from './receipts.js';
import { observeScheduleToStartSeconds } from './schedule-observation.js';
import { loadRunForAdvance } from './state.js';
import {
  assertCoordinatorNotAborted,
  withCoordinatorWriteClient,
} from './transactions.js';

async function advance(
  pool: Pool,
  input: RunAdvanceInput,
  decide: (state: RunAdvanceState) => Promise<RunAdvanceDecision>,
): Promise<RunAdvanceResult> {
  assertCoordinatorNotAborted(input.signal);
  const workspaceId = coordinatorIdentitySchema.parse(input.workspaceId);
  const runId = coordinatorIdentitySchema.parse(input.runId);
  const delivery = coordinatorDeliverySchema.parse(input.delivery);
  const { signal, traceparent } = input;
  let result: RunAdvanceResult & Readonly<{ scheduleDueAt?: string }>;
  try {
    result = await withCoordinatorWriteClient(
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
  if (result.kind !== 'committed' || !('scheduleDueAt' in result))
    return result;
  const { scheduleDueAt, ...committed } = result;
  const scheduleToStartSeconds = await observeScheduleToStartSeconds(
    pool,
    scheduleDueAt,
    signal,
  );
  return Object.freeze({
    ...committed,
    ...(scheduleToStartSeconds === undefined ? {} : { scheduleToStartSeconds }),
  });
}

export function createRunAdvanceStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): RunAdvanceStore {
  const lease = acquireDatabasePool(config, runtime);
  const store: RunAdvanceStore = {
    advance: (input, decide) => advance(lease.pool, input, decide),
    close: () => lease.close(),
  };
  return Object.freeze(store);
}
