import {
  canonicalOutboxPayloadChecksum,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '@pertexo/database/outbox';
import {
  InvalidQueueDeliveryError,
  JOB_NAME,
  type QueueConsumerOptions,
  type QueueDelivery,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createConnectionHealthObservationHandler,
  type ConnectionHealthObservationStore,
} from '../../src/connections/health-runtime.js';
import { maintenanceDeliveryHandler } from '../../src/maintenance/delivery-handler.js';
import { createMaintenanceRuntime } from '../../src/maintenance/runtime.js';

const data = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  outboxEventId: '22222222-2222-4222-8222-222222222222',
  observationId: '33333333-3333-4333-8333-333333333333',
};
const delivery: Extract<
  QueueDelivery,
  { name: 'apply-connection-health-observation' }
> = {
  name: JOB_NAME.applyConnectionHealthObservation,
  data,
  transport: { attemptsMade: 0, jobId: `outbox-${data.outboxEventId}` },
};
const context = { signal: new AbortController().signal };

describe('independent durable health command worker', () => {
  it('loads only the ID with the authoritative checksum', async () => {
    const apply = vi
      .fn<ConnectionHealthObservationStore['apply']>()
      .mockResolvedValue({ kind: 'stale' });
    const handler = createConnectionHealthObservationHandler({ apply });
    await expect(handler.handle(delivery, context)).resolves.toEqual({
      kind: 'stale',
    });
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      workspaceId: data.workspaceId,
      observationId: data.observationId,
      delivery: {
        outboxEventId: data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(data),
      },
      signal: context.signal,
    });
  });

  it('propagates transient application failure; independent redelivery does not involve a provider', async () => {
    const failure = new Error('database unavailable');
    const apply = vi
      .fn<ConnectionHealthObservationStore['apply']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ kind: 'applied' })
      .mockResolvedValueOnce({ kind: 'duplicate' });
    const handler = createConnectionHealthObservationHandler({ apply });
    await expect(handler.handle(delivery, context)).rejects.toBe(failure);
    await expect(handler.handle(delivery, context)).resolves.toEqual({
      kind: 'applied',
    });
    await expect(handler.handle(delivery, context)).resolves.toEqual({
      kind: 'duplicate',
    });
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it.each([
    new InboxChecksumMismatchError(),
    new InboxReceiptUnavailableError(),
  ])(
    'maps durable delivery corruption to poison-job handling %#',
    async (error) => {
      const handler = createConnectionHealthObservationHandler({
        apply: vi.fn().mockRejectedValue(error),
      });
      await expect(handler.handle(delivery, context)).rejects.toMatchObject({
        name: 'UnrecoverableError',
        message: 'Connection health failed durable state verification',
      });
    },
  );

  it('rejects the command when its explicit handler is disabled', async () => {
    await expect(
      maintenanceDeliveryHandler({})(delivery, context),
    ).rejects.toBeInstanceOf(InvalidQueueDeliveryError);
  });

  it('owns the existing maintenance consumer, readiness and store shutdown', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const apply = vi
      .fn<ConnectionHealthObservationStore['apply']>()
      .mockResolvedValue({ kind: 'applied' });
    const checkReadiness = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const consumer = {
      isReady: () => true,
      waitUntilReady: () => Promise.resolve(),
      close: vi.fn().mockResolvedValue({ kind: 'closed' }),
    };
    const runtime = await createMaintenanceRuntime(
      {
        database: {
          connectionString: 'postgresql://worker:unused@localhost/db',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 2,
          ownerRole: 'pertexo_owner',
        },
        redisUrl: 'redis://localhost:6379/0',
      },
      {
        connectionHealthStore: { apply, checkReadiness, close },
        reconciliationStore: { close: vi.fn(), reconcile: vi.fn() },
        unknownOutcomeStore: { close: vi.fn(), reconcile: vi.fn() },
        runReplayStore: { close: vi.fn(), fail: vi.fn(), replay: vi.fn() },
        consumerFactory: (options) => {
          consumerOptions = options;
          return consumer;
        },
      },
    );
    expect(consumerOptions?.queueName).toBe('maintenance');
    await consumerOptions?.handler(delivery, context);
    await runtime.checkReadiness();
    expect(checkReadiness).toHaveBeenCalledOnce();
    await runtime.close();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
    expect(consumer.close).toHaveBeenCalledOnce();
  });
});
