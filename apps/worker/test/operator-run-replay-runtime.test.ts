import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type OperatorRunReplayStore,
} from '@pertexo/database/execution';
import { JOB_NAME } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { createOperatorRunReplayHandler } from '../src/execution/operator-run-replay-runtime.js';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected store spies */

function delivery() {
  const data = {
    commandId: randomUUID(),
    outboxEventId: randomUUID(),
    schemaVersion: 1 as const,
    workspaceId: randomUUID(),
  };
  return {
    name: JOB_NAME.replayWorkflowRun,
    data,
    transport: { attemptsMade: 0, jobId: `outbox-${data.outboxEventId}` },
  } as const;
}

function store(): OperatorRunReplayStore {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    replay: vi.fn().mockResolvedValue({
      kind: 'processed',
      runId: randomUUID(),
    }),
  };
}

describe('operator run replay handler', () => {
  it('forwards exact checksum-bound identity and cancellation', async () => {
    const selectedStore = store();
    const selectedDelivery = delivery();
    const signal = new AbortController().signal;

    await expect(
      createOperatorRunReplayHandler(selectedStore).handle(selectedDelivery, {
        signal,
      }),
    ).resolves.toMatchObject({ kind: 'processed' });
    expect(selectedStore.replay).toHaveBeenCalledWith({
      commandId: selectedDelivery.data.commandId,
      delivery: {
        outboxEventId: selectedDelivery.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(selectedDelivery.data),
      },
      signal,
      workspaceId: selectedDelivery.data.workspaceId,
    });
    expect(selectedStore.fail).not.toHaveBeenCalled();
  });

  it('persists non-executable failure before unrecoverable acknowledgement', async () => {
    const selectedStore = store();
    vi.mocked(selectedStore.replay).mockRejectedValue(
      new OperatorRunReplayNotExecutableError(),
    );
    const selectedDelivery = delivery();

    await expect(
      createOperatorRunReplayHandler(selectedStore).handle(selectedDelivery, {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(selectedStore.fail).toHaveBeenCalledWith({
      commandId: selectedDelivery.data.commandId,
      safeErrorCode: 'version_not_executable',
      workspaceId: selectedDelivery.data.workspaceId,
    });
  });

  it('preserves a failed non-executable persistence write', async () => {
    const selectedStore = store();
    const persistenceFailure = new Error('fail write unavailable');
    vi.mocked(selectedStore.replay).mockRejectedValue(
      new OperatorRunReplayNotExecutableError(),
    );
    vi.mocked(selectedStore.fail).mockRejectedValue(persistenceFailure);

    await expect(
      createOperatorRunReplayHandler(selectedStore).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(persistenceFailure);
  });

  it.each([
    new OperatorRunReplayMismatchError(),
    new InboxChecksumMismatchError(),
    new InboxReceiptUnavailableError(),
  ])(
    'maps durable mismatch %# without writing command failure',
    async (error) => {
      const selectedStore = store();
      vi.mocked(selectedStore.replay).mockRejectedValue(error);

      await expect(
        createOperatorRunReplayHandler(selectedStore).handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ name: 'UnrecoverableError' });
      expect(selectedStore.fail).not.toHaveBeenCalled();
    },
  );

  it('preserves transient and hostile rejected values', async () => {
    for (const error of [
      new Error('postgres unavailable'),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('hostile prototype');
          },
        },
      ),
    ]) {
      const selectedStore = store();
      vi.mocked(selectedStore.replay).mockRejectedValue(error);
      await expect(
        createOperatorRunReplayHandler(selectedStore).handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(error);
      expect(selectedStore.fail).not.toHaveBeenCalled();
    }
  });
});
