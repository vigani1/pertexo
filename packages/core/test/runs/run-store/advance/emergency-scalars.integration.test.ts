import { expect, it } from 'vitest';
import {
  CoordinatorRunStateCorruptError,
  asAdmin,
  rawStore,
  workspaceA,
} from '../run-store.fixture.js';
import { emergencyRun, query } from './emergency.fixture.js';

it.each([
  { field: 'nextEventSequence', value: 'broken' },
  { field: 'deadlineExpired', value: 'broken' },
  { field: 'nextEventSequence', value: 2_147_483_648 },
])(
  'classifies damaged $field ($value) at the coordinator boundary and settles without interpreting it',
  async ({ field, value }) => {
    const f = await emergencyRun();
    await asAdmin((client) =>
      client.query(
        'update app.run_checkpoints set scheduler_state=jsonb_set(scheduler_state,array[$2],$3::jsonb) where workflow_run_id=$1',
        [f.runId, field, JSON.stringify(value)],
      ),
    );
    await expect(
      rawStore.loadAdvanceState({ workspaceId: workspaceA, runId: f.runId }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(f.fail()).resolves.toBe('failed');
    expect(
      (
        await query(
          'select status,completed_at from app.workflow_runs where id=$1',
          [f.runId],
        )
      ).rows,
    ).toEqual([
      { status: 'failed', completed_at: expect.any(Date) as unknown },
    ]);
    expect(
      (
        await query(
          'select completed_at from app.inbox_receipts where message_id=$1',
          [f.delivery.outboxEventId],
        )
      ).rows,
    ).toEqual([{ completed_at: expect.any(Date) as unknown }]);
    expect(
      (
        await query(
          'select status from app.run_failure_notification_intents where workflow_run_id=$1',
          [f.runId],
        )
      ).rows,
    ).toEqual([{ status: 'pending' }]);
  },
);
