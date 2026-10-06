import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settleNativeUnclaimedControl } from '../src/execution/node-attempts/node-attempt-unclaimed-control.js';
const { append, insert } = vi.hoisted(() => ({
  append: vi.fn(),
  insert: vi.fn(),
}));
vi.mock('../src/execution/runs/run-events.js', () => ({
  appendLockedRunEvent: append,
}));
vi.mock('../src/execution/transport/outbox.js', async (original) => ({
  ...(await original<object>()),
  insertOutboxEvent: insert,
}));
const id = '00000000-0000-4000-8000-000000000101';
const input = {
  workspaceId: id,
  runId: id,
  workflowVersionId: id,
  nodeRunId: id,
  attemptId: id,
  invocationKey: 'key',
  nodeId: 'node',
  attemptNumber: 1,
  cancellationRequested: true,
};
function fixture(eligible = true, attemptRows = 1, nodeRows = 1) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ eligible }] })
    .mockResolvedValueOnce({ rowCount: attemptRows })
    .mockResolvedValueOnce({ rowCount: nodeRows });
  return { query, client: { query } as unknown as PoolClient };
}
beforeEach(() => vi.clearAllMocks());
describe('native never-started truthful physical outcome', () => {
  it.each([true, false])(
    'persists existing terminal event/outbox without a synthetic lease or start (cancel=%s)',
    async (cancellationRequested) => {
      const f = fixture();
      await expect(
        settleNativeUnclaimedControl(f.client, {
          ...input,
          cancellationRequested,
        }),
      ).resolves.toMatch(/^[0-9a-f-]{36}$/u);
      const status = cancellationRequested ? 'canceled' : 'timed_out';
      expect(f.query.mock.calls[1]?.[1]).toEqual([
        id,
        id,
        status,
        cancellationRequested
          ? 'execution.canceled'
          : 'execution.deadline_exceeded',
        id,
        1,
      ]);
      expect(f.query.mock.calls[1]?.[0]).toContain(
        'fence_token=0 and started_at is null',
      );
      expect(f.query.mock.calls[1]?.[0]).not.toContain('set started_at');
      expect(f.query.mock.calls[1]?.[0]).not.toContain('set fence_token');
      expect(append).toHaveBeenCalledWith(expect.anything(), id, {
        type: `node.${status}`,
        payload: {
          nodeRunId: id,
          attemptId: id,
          invocationKey: 'key',
          nodeId: 'node',
          attemptNumber: 1,
          safeErrorCode: cancellationRequested
            ? 'execution.canceled'
            : 'execution.deadline_exceeded',
        },
      });
      expect(insert).toHaveBeenCalledOnce();
    },
  );
  it('does not mutate unaccepted or retained native-shaped state', async () => {
    const f = fixture(false);
    await expect(
      settleNativeUnclaimedControl(f.client, input),
    ).resolves.toBeUndefined();
    expect(f.query).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it.each([
    [0, 1],
    [1, 0],
  ])(
    'fails closed on lost physical proof %s/%s',
    async (attemptRows, nodeRows) => {
      const f = fixture(true, attemptRows, nodeRows);
      await expect(
        settleNativeUnclaimedControl(f.client, input),
      ).rejects.toMatchObject({ name: 'NodeAttemptStateCorruptError' });
      expect(append).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );
  it('lets event persistence errors roll back the enclosing actual claim', async () => {
    const f = fixture();
    append.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(settleNativeUnclaimedControl(f.client, input)).rejects.toThrow(
      'audit unavailable',
    );
    expect(insert).not.toHaveBeenCalled();
  });
});
