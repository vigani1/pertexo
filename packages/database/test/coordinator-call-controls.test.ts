import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCoordinatorCallControl,
  persistCoordinatorCallControls,
} from '../src/execution/coordinator/coordinator-call-controls.js';
import type { ParsedTransitionPlan } from '../src/execution/coordinator/coordinator-run-store-plan.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';

const { append, insert } = vi.hoisted(() => ({
  append: vi.fn(),
  insert: vi.fn(),
}));
vi.mock('../src/execution/runs/run-events.js', async (original) => ({
  ...(await original<object>()),
  appendLockedRunEvent: append,
}));
vi.mock('../src/execution/transport/outbox.js', async (original) => ({
  ...(await original<object>()),
  insertOutboxEvent: insert,
}));
const parent = '00000000-0000-4000-8000-000000000101';
const child = '00000000-0000-4000-8000-000000000102';
function fixture(result: unknown, reason = 'cancel_requested') {
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ result }] });
  const input = {
    workspaceId: parent,
    runId: parent,
    delivery: { outboxEventId: parent, payloadChecksum: 'a'.repeat(64) },
    plan: {
      expectedRevision: 2,
      workflowCalls: { cancelChildren: [{ childRunId: child, reason }] },
    } as unknown as ParsedTransitionPlan,
  };
  return { query, input, client: { query } as unknown as PoolClient };
}
beforeEach(() => vi.clearAllMocks());
describe('native child control existing-owner adapter', () => {
  it('does not rewrite or re-wake a protected unchanged child', async () => {
    const f = fixture({ kind: 'unchanged' });
    await persistCoordinatorCallControls(f.client, f.input);
    expect(append).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it('emits a deterministic canonical intent without a child audit', async () => {
    const f = fixture({
      kind: 'requested',
    });
    await persistCoordinatorCallControls(f.client, f.input);
    expect(append).not.toHaveBeenCalled();
    const event = insert.mock.calls[0]?.[1] as {
      id: string;
      payload: unknown;
      payloadChecksum: string;
    };
    expect(event.payloadChecksum).toBe(
      canonicalOutboxPayloadChecksum(event.payload),
    );
    expect(f.query.mock.calls[0]?.[1]).toEqual([
      parent,
      2,
      child,
      'cancel_requested',
      JSON.stringify(f.input.delivery),
    ]);
    expect(event.payload).toMatchObject({ outboxEventId: event.id });
    expect(f.query.mock.calls[0]?.[0]).not.toContain('$6');
    const repeated = fixture({ kind: 'requested' });
    await persistCoordinatorCallControls(repeated.client, repeated.input);
    const repeatedEvent = insert.mock.calls[1]?.[1] as typeof event;
    expect(repeatedEvent.id).toBe(event.id);
  });
  it('wakes an expired deadline without inventing a cancellation event', async () => {
    const f = fixture({ kind: 'wake' }, 'deadline_expired');
    await persistCoordinatorCallControls(f.client, f.input);
    expect(append).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
  });
  it('lets protected control failures escape the parent transaction', async () => {
    const f = fixture({ kind: 'unchanged' });
    f.query
      .mockReset()
      .mockRejectedValue(new Error('protected owner unavailable'));
    await expect(
      persistCoordinatorCallControls(f.client, f.input),
    ).rejects.toThrow('protected owner unavailable');
    expect(insert).not.toHaveBeenCalled();
  });
  it('does not downgrade a malformed protected result to unchanged', async () => {
    const f = fixture({ kind: 'requested', actor: null, reason: null });
    await expect(
      persistCoordinatorCallControls(f.client, f.input),
    ).rejects.toThrow();
    expect(append).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it('lets wakeup insertion failure escape the enclosing parent transaction', async () => {
    const f = fixture({ kind: 'wake' }, 'deadline_expired');
    insert.mockRejectedValueOnce(new Error('wakeup unavailable'));
    await expect(
      persistCoordinatorCallControls(f.client, f.input),
    ).rejects.toThrow('wakeup unavailable');
    expect(f.query.mock.calls[0]?.[1]).toHaveLength(5);
  });
  it('appends audit only for an authenticated child-owned requested result', async () => {
    const f = fixture({
      kind: 'requested',
      actor: `workflow-call:${parent}`,
      reason: 'parent cancellation',
    });
    await applyCoordinatorCallControl(f.client, { ...f.input, runId: child });
    expect(f.query.mock.calls[0]?.[1]).toEqual([
      child,
      JSON.stringify(f.input.delivery),
    ]);
    expect(append).toHaveBeenCalledWith(expect.anything(), child, {
      type: 'run.cancel_requested',
      payload: {
        actor: `workflow-call:${parent}`,
        reason: 'parent cancellation',
      },
    });
    expect(insert).not.toHaveBeenCalled();
  });
  it.each(['unchanged', 'wake'])(
    'does not append audit or complete a receipt for child %s',
    async (kind) => {
      const f = fixture({ kind });
      await applyCoordinatorCallControl(f.client, f.input);
      expect(f.query).toHaveBeenCalledOnce();
      expect(append).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );
});
