import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
} from '@pertexo/database/testing';
import { jobIdForOutboxEvent, JOB_NAME } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createUnknownOutcomeReconciliationHandler,
  mapUnknownOutcomeReconciliationError,
  type UnknownOutcomeReconciliationStore,
} from '../src/execution/unknown-outcome-reconciliation-runtime.js';

function delivery() {
  const data = {
    attemptId: randomUUID(),
    evidenceCommandId: randomUUID(),
    outboxEventId: randomUUID(),
    schemaVersion: 1 as const,
    workspaceId: randomUUID(),
  };
  return {
    data,
    name: JOB_NAME.reconcileUnknownOutcome,
    transport: {
      attemptsMade: 0,
      jobId: jobIdForOutboxEvent(data.outboxEventId),
    },
  } as const;
}

describe('unknown-outcome reconciliation handler', () => {
  it('forwards only checksum-bound evidence identity', async () => {
    const reconcile = vi.fn().mockResolvedValue({ kind: 'processed' });
    const store: UnknownOutcomeReconciliationStore = { reconcile };
    const selected = delivery();
    const signal = new AbortController().signal;
    await expect(
      createUnknownOutcomeReconciliationHandler(store).handle(selected, {
        signal,
      }),
    ).resolves.toEqual({ kind: 'processed' });
    expect(reconcile).toHaveBeenCalledWith({
      attemptId: selected.data.attemptId,
      delivery: {
        outboxEventId: selected.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(selected.data),
      },
      evidenceCommandId: selected.data.evidenceCommandId,
      signal,
      workspaceId: selected.data.workspaceId,
    });
  });

  it.each([
    new UnknownOutcomeReconciliationMismatchError(),
    new UnknownOutcomeReconciliationStateError(),
    new InboxChecksumMismatchError(),
    new InboxReceiptUnavailableError(),
  ])('maps durable reconciliation error %# as unrecoverable', (error) => {
    expect(mapUnknownOutcomeReconciliationError(error)).toMatchObject({
      name: 'UnrecoverableError',
    });
  });

  it('preserves ordinary and hostile rejected values', () => {
    const transient = new Error('postgres unavailable');
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile prototype');
        },
      },
    );
    expect(mapUnknownOutcomeReconciliationError(transient)).toBe(transient);
    expect(mapUnknownOutcomeReconciliationError(hostile)).toBe(hostile);
  });
});
