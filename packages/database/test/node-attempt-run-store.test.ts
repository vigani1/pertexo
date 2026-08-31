import { describe, expect, it } from 'vitest';

import {
  createNodeAttemptRunStore,
  NodeAttemptDeliveryMismatchError,
  parseDatabaseConfig,
} from '../src/testing.js';

describe('NodeAttemptRunStore', () => {
  it('honors an already-aborted claim without opening PostgreSQL work', async () => {
    const store = createNodeAttemptRunStore(
      parseDatabaseConfig({
        connectionString:
          'postgresql://pertexo_worker:unused@127.0.0.1:1/pertexo',
      }),
    );
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(
        store.claimDelivery({
          workspaceId: '11111111-1111-4111-8111-111111111111',
          runId: '22222222-2222-4222-8222-222222222222',
          nodeRunId: '33333333-3333-4333-8333-333333333333',
          attemptId: '44444444-4444-4444-8444-444444444444',
          delivery: {
            outboxEventId: '55555555-5555-4555-8555-555555555555',
            payloadChecksum: 'a'.repeat(64),
          },
          leaseDurationSeconds: 30,
          workerId: 'worker-1',
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await store.close();
    }
  });

  it.each([
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-11111111111A',
    '11111111-1111-4111-7111-111111111111',
  ])('rejects a non-canonical durable identity (%s)', async (workspaceId) => {
    const store = createNodeAttemptRunStore(
      parseDatabaseConfig({
        connectionString:
          'postgresql://pertexo_worker:unused@127.0.0.1:1/pertexo',
      }),
    );
    try {
      await expect(
        store.claimDelivery({
          workspaceId,
          runId: '22222222-2222-4222-8222-222222222222',
          nodeRunId: '33333333-3333-4333-8333-333333333333',
          attemptId: '44444444-4444-4444-8444-444444444444',
          delivery: {
            outboxEventId: '55555555-5555-4555-8555-555555555555',
            payloadChecksum: 'a'.repeat(64),
          },
          leaseDurationSeconds: 30,
          workerId: 'worker-1',
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptDeliveryMismatchError);
    } finally {
      await store.close();
    }
  });
});
