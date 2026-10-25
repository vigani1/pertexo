import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAttemptRunStore,
  parseDatabaseConfig,
  type NodeAttemptLease,
} from '../../src/testing.js';
import { createDatabaseRuntime } from '../../src/platform/pool/runtime.js';

const config = parseDatabaseConfig({
  connectionString: 'postgresql://pertexo_app:unused@invalid.invalid/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
});
const identity = {
  attemptId: '44444444-4444-4444-8444-444444444444',
  nodeRunId: '33333333-3333-4333-8333-333333333333',
  outboxEventId: '55555555-5555-4555-8555-555555555555',
  runId: '22222222-2222-4222-8222-222222222222',
  workflowVersionId: '66666666-6666-4666-8666-666666666666',
  workspaceId: '11111111-1111-4111-8111-111111111111',
} as const;
const delivery = {
  outboxEventId: identity.outboxEventId,
  payloadChecksum: 'a'.repeat(64),
} as const;
const lease = {
  admissionKind: 'execute',
  attemptId: identity.attemptId,
  attemptNumber: 1,
  delivery,
  fenceToken: 1,
  invocationKey: `${identity.workflowVersionId}|node|b:|i:`,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  nodeId: 'node',
  nodeRunId: identity.nodeRunId,
  runId: identity.runId,
  sideEffectClass: 'safe',
  workerId: 'worker-1',
  workflowVersionId: identity.workflowVersionId,
  workspaceId: identity.workspaceId,
} as const satisfies NodeAttemptLease;

type Store = ReturnType<typeof createNodeAttemptRunStore>;
type CheckoutSpy = ReturnType<typeof vi.spyOn>;

async function withNoCheckoutStore(
  operation: (store: Store, checkout: CheckoutSpy) => Promise<void>,
): Promise<void> {
  const checkout = vi
    .spyOn(Pool.prototype, 'connect')
    .mockImplementation(() => {
      throw new Error('Unexpected PostgreSQL checkout');
    });
  const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
  const store = createNodeAttemptRunStore(config, runtime);
  try {
    await operation(store, checkout);
  } finally {
    checkout.mockRestore();
    await Promise.all([store.close(), runtime.close()]);
  }
}

describe('NodeAttemptRunStore', () => {
  it.each([
    [
      'claim',
      (store: Store, signal: AbortSignal) =>
        store.claimDelivery({
          ...identity,
          delivery,
          leaseDurationSeconds: 30,
          signal,
          workerId: lease.workerId,
        }),
    ],
    [
      'load',
      (store: Store, signal: AbortSignal) =>
        store.loadInputs({ lease, signal, upstreamNodeOutputs: [] }),
    ],
    [
      'dispatch',
      (store: Store, signal: AbortSignal) =>
        store.markDispatched({ lease, signal }),
    ],
    [
      'heartbeat',
      (store: Store, signal: AbortSignal) =>
        store.heartbeat({ lease, leaseDurationSeconds: 30, signal }),
    ],
    [
      'complete',
      (store: Store, signal: AbortSignal) =>
        store.complete({
          lease,
          outcome: { output: null, status: 'succeeded' },
          signal,
        }),
    ],
  ] as const)(
    'rejects an already-aborted %s before PostgreSQL checkout',
    async (_name, invoke) => {
      await withNoCheckoutStore(async (store, checkout) => {
        const controller = new AbortController();
        controller.abort();

        await expect(invoke(store, controller.signal)).rejects.toMatchObject({
          name: 'AbortError',
        });
        expect(checkout).not.toHaveBeenCalled();
      });
    },
  );
});
