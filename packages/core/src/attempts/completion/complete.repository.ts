import {
  withTenantScopedClient,
  rethrowQueryFailure,
  serializeStoredExecutionValue,
} from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  lockCompletionReceipt,
  lockCompletionRun,
  lockCompletionAttempt,
} from './records.repository.js';
import type { Pool } from 'pg';
import {
  DeliveryMismatch,
  NodeAttemptOutputInvalidError,
  NodeAttemptStateCorruptError,
} from '../errors.js';
import type {
  CompleteNodeAttemptResult,
  NodeAttemptRunStore,
} from '../contract.js';
import { auditMismatch, validateDelivery } from './receipts.repository.js';
import { applyNodeAttemptCompletion } from './outcomes.repository.js';
import { StoredExecutionValueInvalidError } from '@pertexo/database/platform';

export async function completeNodeAttempt(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['complete']>[0],
): Promise<CompleteNodeAttemptResult> {
  let serializedOutput: string | null = null;
  if (
    input.outcome.status === 'succeeded' ||
    input.outcome.status === 'suspended'
  ) {
    try {
      serializedOutput = serializeStoredExecutionValue({
        kind: 'inline',
        value: input.outcome.output,
      });
    } catch (error: unknown) {
      if (error instanceof StoredExecutionValueInvalidError)
        throw new NodeAttemptOutputInvalidError({ cause: error });
      throw error;
    }
  }
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: input.lease.workspaceId },
      async (client) => {
        await drizzle(client)
          .execute(
            sql`select app.lock_workspace_run_admission(${input.lease.workspaceId})`,
          )
          .catch(rethrowQueryFailure);
        await validateDelivery(client, {
          workspaceId: input.lease.workspaceId,
          runId: input.lease.runId,
          nodeRunId: input.lease.nodeRunId,
          attemptId: input.lease.attemptId,
          delivery: input.lease.delivery,
          leaseDurationSeconds: 1,
          workerId: input.lease.workerId,
          signal: input.signal,
        });
        const receipt = await lockCompletionReceipt(client, input);
        const receiptRow = receipt[0];
        if (
          receiptRow?.payloadChecksum !== input.lease.delivery.payloadChecksum
        )
          throw new NodeAttemptStateCorruptError();

        const run = await lockCompletionRun(client, input);
        if (run.length !== 1) throw new NodeAttemptStateCorruptError();
        const locked = await lockCompletionAttempt(client, input);
        const row = locked[0];
        if (row === undefined) throw new NodeAttemptStateCorruptError();
        return applyNodeAttemptCompletion(client, input, {
          row,
          receipt: receiptRow,
          serializedOutput,
          controlActive: (run[0]?.abortReason ?? null) !== null,
        });
      },
      { signal: input.signal },
    );
  } catch (error: unknown) {
    if (error instanceof DeliveryMismatch)
      return auditMismatch(
        pool,
        input.lease.workspaceId,
        input.lease.delivery,
        input.signal,
      );
    throw error;
  }
}
