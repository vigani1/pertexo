import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { lockCoordinatorCommitState } from '../src/execution/coordinator/coordinator-run-store-commit-state.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const payload = { schemaVersion: 1, workspaceId, runId, expectedRevision: 0 };
const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
const input = {
  workspaceId,
  runId,
  workflowVersionId: '33333333-3333-4333-8333-333333333333',
  checkpointJson: '{}',
  planFingerprint: 'unused',
  delivery: {
    outboxEventId: '44444444-4444-4444-8444-444444444444',
    payloadChecksum,
  },
  // These cases terminate before plan interpretation; no transition is modeled.
  plan: {},
} as Parameters<typeof lockCoordinatorCommitState>[1];
const deliveryRow = {
  aggregate_id: runId,
  aggregate_type: 'workflow-run',
  job_name: 'advance-workflow-run',
  payload,
  payload_checksum: payloadChecksum,
  schema_version: 1,
};

it('awaits the exact run lock before issuing the independent checkpoint lock', async () => {
  const runLock = Promise.withResolvers<{ rows: { id: string }[] }>();
  const requestedRun = Promise.withResolvers<boolean>();
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [deliveryRow] })
    .mockImplementationOnce(() => {
      requestedRun.resolve(true);
      return runLock.promise;
    })
    .mockResolvedValueOnce({ rows: [] });
  const result = lockCoordinatorCommitState(
    { query } as unknown as PoolClient,
    input,
  );
  await requestedRun.promise;
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]?.[0]).toMatch(
    /from app\.workflow_runs\s+where workspace_id=\$1 and id=\$2 for no key update$/u,
  );
  expect(query.mock.calls[1]?.[0]).not.toContain('checkpoint');
  runLock.resolve({ rows: [{ id: runId }] });
  await expect(result).resolves.toEqual({
    kind: 'outcome',
    result: { kind: 'not_found' },
  });
  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[2]?.[0]).toMatch(/for no key update of checkpoint$/u);
  expect(query.mock.calls[2]?.[0]).not.toMatch(/of run, checkpoint/u);
  for (const call of query.mock.calls.slice(1))
    expect(call[1]).toEqual([workspaceId, runId]);
});

it('does not lock a checkpoint or claim a receipt when the run is absent', async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [deliveryRow] })
    .mockResolvedValueOnce({ rows: [] });
  await expect(
    lockCoordinatorCommitState({ query } as unknown as PoolClient, input),
  ).resolves.toEqual({ kind: 'outcome', result: { kind: 'not_found' } });
  expect(query).toHaveBeenCalledTimes(2);
});

it('still authenticates the durable delivery before either row lock', async () => {
  const query = vi.fn().mockResolvedValueOnce({
    rows: [{ ...deliveryRow, payload_checksum: '0'.repeat(64) }],
  });
  await expect(
    lockCoordinatorCommitState({ query } as unknown as PoolClient, input),
  ).rejects.toMatchObject({ name: 'Error' });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toContain('from app.outbox_events');
});
