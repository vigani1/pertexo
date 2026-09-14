import { readFileSync } from 'node:fs';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAttemptRunStore,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
  parseDatabaseConfig,
  type NodeAttemptLease,
} from '../src/testing.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import { scopedInvocationKey } from '../src/execution/node-attempt-run-store-transactions.js';

const invocationKeyCases = JSON.parse(
  readFileSync(
    new URL('./fixtures/invocation-key-conformance.json', import.meta.url),
    'utf8',
  ),
) as unknown as readonly Readonly<{
  expected: string;
  input: Readonly<{
    branchPath?: readonly Readonly<{ nodeId: string; outputPort: string }>[];
    iterationPath?: readonly Readonly<{
      loopNodeId: string;
      ordinal: number;
    }>[];
    nodeId: string;
    workflowVersionId: string;
  }>;
  name: string;
}>[];

const config = parseDatabaseConfig({
  connectionString:
    'postgresql://pertexo_worker:unused@invalid.invalid/pertexo',
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
  it.each(invocationKeyCases)(
    'keeps the $name invocation-key encoding byte-compatible',
    ({ expected, input }) => {
      expect(scopedInvocationKey(input)).toBe(expected);
    },
  );

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

  it.each([
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-11111111111A',
    '11111111-1111-4111-7111-111111111111',
  ])(
    'rejects a non-canonical claim identity (%s) before checkout',
    async (workspaceId) => {
      await withNoCheckoutStore(async (store, checkout) => {
        await expect(
          store.claimDelivery({
            ...identity,
            workspaceId,
            delivery,
            leaseDurationSeconds: 30,
            workerId: lease.workerId,
            signal: new AbortController().signal,
          }),
        ).rejects.toBeInstanceOf(NodeAttemptDeliveryMismatchError);
        expect(checkout).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    [
      'load',
      (store: Store, invalidLease: NodeAttemptLease) =>
        store.loadInputs({
          lease: invalidLease,
          signal: new AbortController().signal,
          upstreamNodeOutputs: [],
        }),
    ],
    [
      'dispatch',
      (store: Store, invalidLease: NodeAttemptLease) =>
        store.markDispatched({
          lease: invalidLease,
          signal: new AbortController().signal,
        }),
    ],
    [
      'heartbeat',
      (store: Store, invalidLease: NodeAttemptLease) =>
        store.heartbeat({
          lease: invalidLease,
          leaseDurationSeconds: 30,
          signal: new AbortController().signal,
        }),
    ],
    [
      'complete',
      (store: Store, invalidLease: NodeAttemptLease) =>
        store.complete({
          lease: invalidLease,
          outcome: { output: null, status: 'succeeded' },
          signal: new AbortController().signal,
        }),
    ],
  ] as const)(
    'rejects malformed %s lease scope before PostgreSQL checkout',
    async (_name, invoke) => {
      await withNoCheckoutStore(async (store, checkout) => {
        const invalidLease = {
          ...lease,
          workspaceId: '00000000-0000-0000-0000-000000000000',
        } satisfies NodeAttemptLease;
        await expect(invoke(store, invalidLease)).rejects.toBeInstanceOf(
          NodeAttemptStateCorruptError,
        );
        expect(checkout).not.toHaveBeenCalled();
      });
    },
  );
});
