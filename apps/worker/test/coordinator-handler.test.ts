import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import { JOB_NAME, type QueueDelivery } from '@pertexo/queue';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createCoordinatorHandler,
  CoordinatorHandlerStateError,
  type CoordinatorHandlerDependencies,
} from '../src/execution/coordinator-handler.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';
const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

function delivery(
  traced = true,
): Extract<QueueDelivery, { name: 'advance-workflow-run' }> {
  return {
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      outboxEventId: OUTBOX_EVENT_ID,
      ...(traced ? { traceparent: TRACEPARENT } : {}),
    },
    transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
  };
}

function handlerWith(
  advance: ReturnType<typeof vi.fn>,
  options: { resyncFailure?: Error; telemetryFailure?: Error } = {},
) {
  const resync =
    options.resyncFailure === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(options.resyncFailure);
  const scheduleStarted = vi.fn(() => {
    if (options.telemetryFailure !== undefined) throw options.telemetryFailure;
  });
  const handler = createCoordinatorHandler({
    advance: advance as CoordinatorHandlerDependencies['advance'],
    notifications: {
      close: vi.fn(),
      publish: vi.fn(),
      resync,
    },
    telemetry: { scheduleStarted },
  });
  return { handler, resync, scheduleStarted };
}

const context = () => ({ signal: new AbortController().signal }) as never;

describe('coordinator handler', () => {
  it('advances the delivered run and resyncs viewers after a commit', async () => {
    const advance = vi.fn().mockResolvedValue({
      kind: 'committed',
      revision: 3,
      admittedAttempts: [],
      scheduleToStartSeconds: 2,
    });
    const { handler, resync, scheduleStarted } = handlerWith(advance);
    const selectedContext = context();

    await expect(handler.handle(delivery(), selectedContext)).resolves.toEqual({
      kind: 'committed',
      revision: 3,
    });
    expect(advance).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      delivery: {
        outboxEventId: OUTBOX_EVENT_ID,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery().data),
      },
      traceparent: TRACEPARENT,
      signal: (selectedContext as { signal: AbortSignal }).signal,
    });
    expect(scheduleStarted).toHaveBeenCalledWith(2);
    expect(resync).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
    });
  });

  it('omits absent trace context', async () => {
    const advance = vi
      .fn()
      .mockResolvedValue({ kind: 'no_change', revision: 1 });
    const { handler } = handlerWith(advance);

    await handler.handle(delivery(false), context());
    expect(advance.mock.calls[0]?.[0]).not.toHaveProperty('traceparent');
  });

  it.each(['no_change', 'already_committed', 'deferred'] as const)(
    'reports %s without resyncing viewers',
    async (kind) => {
      const advance = vi.fn().mockResolvedValue({ kind, revision: 4 });
      const { handler, resync } = handlerWith(advance);

      await expect(handler.handle(delivery(), context())).resolves.toEqual({
        kind,
        revision: 4,
      });
      expect(resync).not.toHaveBeenCalled();
    },
  );

  it.each(['not_found', 'not_executable', 'capacity_exceeded'] as const)(
    'fails the delivery for a run that cannot advance: %s',
    async (kind) => {
      const { handler } = handlerWith(vi.fn().mockResolvedValue({ kind }));

      await expect(handler.handle(delivery(), context())).rejects.toEqual(
        new CoordinatorHandlerStateError(kind),
      );
    },
  );

  it('fails the delivery for a checkpoint the engine cannot read', async () => {
    const { handler } = handlerWith(
      vi
        .fn()
        .mockRejectedValue(
          new WorkflowEngineError('checkpoint_unsupported', 'unsupported'),
        ),
    );

    await expect(handler.handle(delivery(), context())).rejects.toEqual(
      new CoordinatorHandlerStateError('unsupported_checkpoint'),
    );
  });

  it('lets other failures retry', async () => {
    const failure = new Error('database unavailable');
    const { handler } = handlerWith(vi.fn().mockRejectedValue(failure));

    await expect(handler.handle(delivery(), context())).rejects.toBe(failure);
  });

  it('contains resync and telemetry failures after a commit', async () => {
    const advance = vi.fn().mockResolvedValue({
      kind: 'committed',
      revision: 2,
      admittedAttempts: [],
      scheduleToStartSeconds: 1,
    });
    const { handler } = handlerWith(advance, {
      resyncFailure: new Error('redis unavailable'),
      telemetryFailure: new Error('meter unavailable'),
    });

    await expect(handler.handle(delivery(), context())).resolves.toEqual({
      kind: 'committed',
      revision: 2,
    });
  });
});
