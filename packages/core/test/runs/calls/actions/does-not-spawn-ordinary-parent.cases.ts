import { expect, it } from 'vitest';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { calls, pending, initial, outcome } from './fixture.js';

export function registerDoesNotSpawnOrdinaryParent(): void {
  it('does not spawn while ordinary parent work is still dispatched', async () => {
    const fixture = await pending();
    await admin.query(
      "update app.run_checkpoints set scheduler_state=jsonb_set(scheduler_state,'{invocations}',scheduler_state->'invocations' || $2::jsonb) where workflow_run_id=$1",
      [
        fixture.parentRunId,
        JSON.stringify([
          {
            nodeId: 'ordinary',
            invocationKey: `${fixture.parentVersionId}|ordinary|b:|i:`,
            status: 'running',
            attemptNumber: 1,
          },
        ]),
      ],
    );
    await calls.performActions(fixture.input, initial);
    expect(await outcome(fixture.parentRunId)).toMatchObject({
      status: 'pending',
      child_run_id: null,
    });
  });

  it('keeps an accepted child pin and absolute deadline unchanged on redelivery', async () => {
    const fixture = await pending();
    await calls.performActions(fixture.input, initial);
    const accepted = await outcome(fixture.parentRunId);
    const recorded = (
      await admin.query(
        'select deadline_at from app.workflow_calls where id=$1',
        [accepted.id],
      )
    ).rows[0] as unknown;
    expect(
      (
        await admin.query(
          'select deadline_at from app.workflow_runs where id=$1',
          [accepted.child_run_id],
        )
      ).rows[0],
    ).toEqual(recorded);
    await admin.query(
      "update app.workflows set lifecycle_status='archived' where id=$1",
      [fixture.childWorkflowId],
    );
    await calls.performActions(fixture.input, () => {
      throw new Error(
        'accepted identity must recover before rechecking the target',
      );
    });
    expect(await outcome(fixture.parentRunId)).toEqual(accepted);
    expect(
      (
        await admin.query(
          'select deadline_at from app.workflow_runs where id=$1',
          [accepted.child_run_id],
        )
      ).rows[0],
    ).toEqual(recorded);
  });

  it('rejects a changed delivery checksum before any action writes', async () => {
    const fixture = await pending();
    await expect(
      calls.performActions(
        {
          ...fixture.input,
          delivery: {
            ...fixture.input.delivery,
            payloadChecksum: '0'.repeat(64),
          },
        },
        initial,
      ),
    ).rejects.toThrow(/durable transport|does not match/u);
    expect(await outcome(fixture.parentRunId)).toMatchObject({
      status: 'pending',
      child_run_id: null,
    });
  });
}
