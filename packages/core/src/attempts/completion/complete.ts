import { lockWorkspaceRunAdmission } from '../../runs/admission-locks.queries.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { serializeStoredExecutionValue } from '../../runs/values/stored-execution.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  lockCompletionReceipt,
  lockCompletionRun,
  lockCompletionAttempt,
} from './records.queries.js';
import type { Pool } from 'pg';
import {
  DeliveryMismatch,
  NodeAttemptOutputInvalidError,
  NodeAttemptStateCorruptError,
} from '../errors.js';
import type {
  CompleteNodeAttemptResult,
  CompleteAttemptInput,
} from '../contract.js';
import { auditMismatch, validateDelivery } from './receipts.queries.js';
import { applyNodeAttemptCompletion } from './outcomes.js';
import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';

export async function completeNodeAttempt(
  pool: Pool,
  input: CompleteAttemptInput,
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
        await lockWorkspaceRunAdmission(
          drizzle(client),
          input.lease.workspaceId,
        );
        await validateDelivery(client, {
          workspaceId: input.lease.workspaceId,
          runId: input.lease.runId,
          nodeRunId: input.lease.nodeRunId,
          attemptId: input.lease.attemptId,
          delivery: input.lease.delivery,
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
