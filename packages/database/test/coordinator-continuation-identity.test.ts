import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { persistCoordinatorRunTransition } from '../src/execution/coordinator/coordinator-run-store-run-transition.js';
import { parseTransitionPlan } from '../src/execution/coordinator/coordinator-run-store-plan.js';
import type { CoordinatorCommitRow } from '../src/execution/coordinator/coordinator-run-store-commit-state.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';

const id = '00000000-1111-4111-8111-111111111111';
function plan(immediate = true, terminal = false) {
  return parseTransitionPlan({
    expectedRevision: 0,
    expectedNextEventSequence: 2,
    consumedThroughEventSequence: 1,
    checkpoint: {
      schemaVersion: 2,
      engineVersion: 'engine-v2',
      workflowVersionId: id,
      revision: 1,
      runStatus: terminal ? 'succeeded' : 'running',
      nextEventSequence: 3,
      readySet: [],
      admittedInvocationKeys: [],
      invocations: [],
      joins: [],
      loops: [],
      remainingIterationBudget: 1_000,
      cancelRequested: false,
      deadlineExpired: false,
      branchSelections: [],
    },
    events: [
      {
        schemaVersion: 1,
        sequence: 2,
        name: terminal ? 'run.succeeded' : 'run.started',
        occurredAt: '2026-10-02T00:00:00.000Z',
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
    ...(immediate ? { immediateContinuation: true } : {}),
  });
}
const row: CoordinatorCommitRow = {
  revision: 0,
  scheduler_state: {},
  last_transition_fingerprint: null,
  workflow_version_id: id,
  status: 'queued',
  cancel_requested_at: null,
  deadline_expired: false,
  workflow_id: id,
  trigger_type: 'manual',
  started_at: null,
  created_at: new Date('2026-10-02T00:00:00.000Z'),
  failure_notification_policy_version: null,
  failure_notification_destination_id: null,
  failure_notification_destination_config_version: null,
  failure_notification_side_effect_class: null,
  execution_entitlement_version: 1,
  input_ref: { schemaVersion: 1, kind: 'inline', value: null },
};
async function persist(query: ReturnType<typeof vi.fn>, transition = plan()) {
  return persistCoordinatorRunTransition({ query } as unknown as PoolClient, {
    authoritativeCancellation: false,
    checkpointJson: JSON.stringify(transition.checkpoint),
    plan: transition,
    planFingerprint: 'a'.repeat(64),
    row,
    runTimeoutFailureContextEnabled: false,
    workspaceInboxProducerEnabled: false,
    workflowTriggerOutcomesEnabled: false,
    runId: id,
    workflowVersionId: id,
    workspaceId: id,
  });
}
describe('actual coordinator continuation writer identity (mocked client)', () => {
  it('returns the exact canonical continuation inserted after its checkpoint CAS and run transition', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const result = await persist(query);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain('update app.run_checkpoints');
    expect(query.mock.calls[1]?.[0]).toContain('update app.workflow_runs');
    expect(query.mock.calls[2]?.[0]).toContain('insert into app.outbox_events');
    const args = query.mock.calls[2]?.[1] as unknown[];
    expect(result.continuationOutboxEventId).toBe(args[0]);
    const payload: unknown = JSON.parse(args[3] as string);
    expect(args[4]).toBe(canonicalOutboxPayloadChecksum(payload));
    expect(payload).toEqual({
      schemaVersion: 1,
      runId: id,
      workspaceId: id,
      outboxEventId: result.continuationOutboxEventId,
    });
  });
  it.each([
    ['not requested', false, false],
    ['terminal', true, true],
  ] as const)(
    'does not invent a continuation when %s',
    async (_name, immediate, terminal) => {
      const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
      await expect(persist(query, plan(immediate, terminal))).resolves.toEqual(
        {},
      );
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
  it('does not insert or return continuation identity after a failed CAS', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(persist(query)).rejects.toThrow();
    expect(query).toHaveBeenCalledOnce();
  });
  it('propagates continuation write failure without claiming a committed identifier', async () => {
    const failure = new Error('outbox write failed');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockRejectedValueOnce(failure);
    await expect(persist(query)).rejects.toBe(failure);
  });
});
