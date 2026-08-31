import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { jobIdForOutboxEvent, JOB_NAME } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewReconciliationHandler,
  type PreviewReconciliationStore,
} from '../src/execution/preview-reconciliation-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';

function delivery() {
  const data = {
    schemaVersion: 1 as const,
    workspaceId: randomUUID(),
    outboxEventId: randomUUID(),
    previewRunId: randomUUID(),
    previewAttemptId: randomUUID(),
    attemptFenceToken: 7,
  };
  return {
    name: JOB_NAME.reconcilePreviewAttempt,
    data,
    transport: {
      attemptsMade: 0,
      jobId: jobIdForOutboxEvent(data.outboxEventId),
    },
  } as const;
}

describe('preview reconciliation handler', () => {
  it('forwards one identifier-only, checksum-bound reconciliation decision', async () => {
    const reconcile = vi.fn().mockResolvedValue({ kind: 'redelivered' });
    const recordReconciliation = vi.fn();
    const recordTerminal = vi.fn();
    const store: PreviewReconciliationStore = { reconcile };
    const selected = delivery();
    const signal = new AbortController().signal;

    await expect(
      createPreviewReconciliationHandler(store, {
        recordReconciliation,
        recordTerminal,
      }).handle(selected, { signal }),
    ).resolves.toEqual({ kind: 'redelivered' });
    expect(reconcile).toHaveBeenCalledWith({
      attemptFenceToken: selected.data.attemptFenceToken,
      delivery: {
        outboxEventId: selected.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(selected.data),
      },
      previewAttemptId: selected.data.previewAttemptId,
      previewRunId: selected.data.previewRunId,
      signal,
      workspaceId: selected.data.workspaceId,
    });
    expect(recordReconciliation).toHaveBeenCalledWith({
      decision: 'redelivered',
    });
    expect(recordTerminal).not.toHaveBeenCalled();
  });

  it('records a terminal reconciliation only after its durable completion', async () => {
    const recordReconciliation = vi.fn();
    const recordTerminal = vi.fn();
    const selected = delivery();
    await expect(
      createPreviewReconciliationHandler(
        {
          reconcile: vi.fn().mockResolvedValue({
            kind: 'completed',
            mayContactProvider: true,
            mayCauseExternalSideEffect: true,
            operationKey: 'request',
            possiblyDispatched: true,
            providerKey: 'http',
            sideEffectClass: 'unsafe',
            status: 'outcome_unknown',
            usesConnection: true,
          }),
        },
        { recordReconciliation, recordTerminal },
      ).handle(selected, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'completed', status: 'outcome_unknown' });
    expect(recordReconciliation).toHaveBeenCalledWith({
      decision: 'completed',
      outcome: 'outcome_unknown',
    });
    expect(recordTerminal).toHaveBeenCalledWith({
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      operationKey: 'request',
      outcome: 'outcome_unknown',
      possiblyDispatched: true,
      providerKey: 'http',
      sideEffectClass: 'unsafe',
      source: 'reconciliation',
      usesConnection: true,
    });
  });

  it('rejects a transport identity that is not derived from the outbox row', async () => {
    const reconcile = vi.fn();
    const selected = delivery();

    await expect(
      createPreviewReconciliationHandler({ reconcile }).handle(
        {
          ...selected,
          transport: { ...selected.transport, jobId: 'forged-job' },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/transport identity/i);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('closes the durable store when consumer construction fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const store = { close, reconcile: vi.fn() };

    await expect(
      createPreviewMaintenanceRuntime(
        {
          database: parseDatabaseConfig({
            connectionString:
              'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          }),
          redisUrl: 'redis://localhost:6379/0',
        },
        {
          consumerFactory: () => {
            throw new Error('consumer construction failed');
          },
          reconciliationStore: store,
        },
      ),
    ).rejects.toThrow('consumer construction failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the maintenance consumer and store exactly once', async () => {
    const consumerClose = vi
      .fn()
      .mockResolvedValue({ abortedJobs: 0, forced: false });
    const storeClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await createPreviewMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        }),
        redisUrl: 'redis://localhost:6379/0',
      },
      {
        consumerFactory: vi.fn().mockReturnValue({
          close: consumerClose,
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        reconciliationStore: { close: storeClose, reconcile: vi.fn() },
      },
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
  });
});
