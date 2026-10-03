import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNodeAttemptDelivery } from '../src/execution/node-attempts/node-attempt-run-store-claim.js';

const { settle, complete } = vi.hoisted(() => ({
  settle: vi.fn(),
  complete: vi.fn(),
}));
vi.mock(
  '../src/execution/node-attempts/node-attempt-unclaimed-control.js',
  () => ({ settleNativeUnclaimedControl: settle }),
);
vi.mock(
  '../src/execution/node-attempts/node-attempt-run-store-delivery.js',
  () => ({
    validateDelivery: vi.fn(),
    claimReceipt: vi.fn().mockResolvedValue('new'),
    completeReceipt: complete,
    auditMismatch: vi.fn(),
  }),
);
vi.mock(
  '../src/execution/node-attempts/node-attempt-run-store-transactions.js',
  async (original) => ({
    ...(await original<object>()),
    withWorkspaceWriteClient: async (
      pool: Pool,
      _workspace: string,
      _signal: AbortSignal,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation(pool as unknown as PoolClient),
  }),
);
const id = '00000000-0000-4000-8000-000000000101';
const input = {
  workspaceId: id,
  runId: id,
  nodeRunId: id,
  attemptId: id,
  workerId: 'worker',
  leaseDurationSeconds: 30,
  delivery: { outboxEventId: id, payloadChecksum: 'a'.repeat(64) },
  signal: new AbortController().signal,
};
function fixture(schema = '3', mutation: Record<string, unknown> = {}) {
  const row = {
    attempt_status: 'ready',
    node_status: 'ready',
    fence_token: '0',
    lease_expires_at: null,
    lease_valid: false,
    dispatch_marked_at: null,
    provider_dispatch_unresolved: false,
    invocation_key: 'key',
    node_id: 'node',
    attempt_number: 1,
    ...mutation,
  };
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ run_id: id }] })
    .mockResolvedValueOnce({
      rows: [
        {
          checkpoint_schema_version: schema,
          workflow_version_id: id,
          control_active: true,
          cancel_requested_at: new Date(),
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [row] });
  return { query } as unknown as Pool;
}
beforeEach(() => {
  vi.clearAllMocks();
  settle.mockResolvedValue(id);
});
describe('native never-started claim control guard', () => {
  it('settles actual native control and completes the existing receipt without a lease', async () => {
    await expect(claimNodeAttemptDelivery(fixture(), input)).resolves.toEqual({
      kind: 'control_settled',
      outboxEventId: id,
    });
    expect(settle).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      id,
      input.delivery,
    );
    expect(settle.mock.calls[0]?.[1]).not.toHaveProperty('lease');
  });
  it.each(['1', '2'])(
    'retains schema%s guard and never calls an unregistered native helper',
    async (schema) => {
      await expect(
        claimNodeAttemptDelivery(fixture(schema), input),
      ).rejects.toMatchObject({ name: 'NodeAttemptControlActiveError' });
      expect(settle).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );
  it.each([
    { fence_token: '1' },
    { dispatch_marked_at: new Date() },
    { provider_dispatch_unresolved: true },
  ])(
    'preserves reconciliation truth for ambiguous ready attempt %j',
    async (mutation) => {
      await expect(
        claimNodeAttemptDelivery(fixture('3', mutation), input),
      ).rejects.toMatchObject({ name: 'NodeAttemptControlActiveError' });
      expect(settle).not.toHaveBeenCalled();
    },
  );
  it('preserves live claimed attempts without native settlement', async () => {
    await expect(
      claimNodeAttemptDelivery(
        fixture('3', {
          attempt_status: 'running',
          lease_valid: true,
          lease_expires_at: new Date(),
        }),
        input,
      ),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(settle).not.toHaveBeenCalled();
  });
  it('preserves expired claimed reconciliation guard', async () => {
    await expect(
      claimNodeAttemptDelivery(
        fixture('3', { attempt_status: 'running' }),
        input,
      ),
    ).rejects.toMatchObject({ name: 'NodeAttemptReconciliationRequiredError' });
    expect(settle).not.toHaveBeenCalled();
  });
  it('fails closed when protected accepted-native authority is absent', async () => {
    settle.mockResolvedValue(undefined);
    await expect(
      claimNodeAttemptDelivery(fixture(), input),
    ).rejects.toMatchObject({ name: 'NodeAttemptControlActiveError' });
    expect(complete).not.toHaveBeenCalled();
  });
});
