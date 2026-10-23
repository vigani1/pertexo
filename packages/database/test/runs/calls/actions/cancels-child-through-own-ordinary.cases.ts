import { expect, it } from 'vitest';
import { CallableInputInvalidError } from '@pertexo/workflow-model';

import {
  parseCheckpoint,
  type WorkflowTransitionPlan,
} from '../../../../../workflow-engine/dist/index.js';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { runs, calls, pending, initial, outcome } from './fixture.js';

export function registerCancelsChildThroughOwnOrdinary(): void {
  it('cancels the child through its own ordinary control and releases the closed parent loan exactly once', async () => {
    const fixture = await pending();
    await calls.performActions(fixture.input, initial);
    const accepted = await outcome(fixture.parentRunId);
    const childRunId = accepted.child_run_id;
    if (childRunId === null) throw new Error('child not accepted');
    const occurredAt = new Date().toISOString();
    await runs.advance(fixture.input, (state) => {
      const previous = parseCheckpoint(state.checkpoint);
      const plan: WorkflowTransitionPlan = {
        ...fixture.plan,
        callIntents: [],
        expectedRevision: 1,
        expectedNextEventSequence: 3,
        consumedThroughEventSequence: 2,
        checkpoint: {
          ...previous,
          revision: 2,
          nextEventSequence: 5,
          runStatus: 'failed',
          invocations: [
            {
              nodeId: 'call',
              invocationKey: fixture.key,
              status: 'failed',
              attemptNumber: 1,
            },
          ],
        },
        events: [
          {
            sequence: 3,
            name: 'node.failed',
            nodeId: 'call',
            invocationKey: fixture.key,
            attemptNumber: 1,
            occurredAt,
            reasonCode: 'required_node_failed',
          },
          {
            sequence: 4,
            name: 'run.failed',
            occurredAt,
            reasonCode: 'required_node_failed',
          },
        ],
      };
      return Promise.resolve({ kind: 'transition', previous, plan });
    });
    const childHint = (
      await admin.query<{ id: string; payload_checksum: string }>(
        "select id,payload_checksum from app.outbox_events where aggregate_id=$1 and payload->>'runId'=$1::text order by created_at desc limit 1",
        [childRunId],
      )
    ).rows[0];
    if (childHint === undefined) throw new Error('child control hint missing');
    const childInput = {
      ...fixture.input,
      runId: childRunId,
      delivery: {
        outboxEventId: childHint.id,
        payloadChecksum: childHint.payload_checksum,
      },
    };
    await calls.performActions(childInput, initial);
    expect(
      (
        await admin.query(
          'select cancel_reason,cancel_requested_by from app.workflow_runs where id=$1',
          [childRunId],
        )
      ).rows,
    ).toEqual([
      {
        cancel_reason: 'parent_closed',
        cancel_requested_by: `workflow-call:${accepted.id}`,
      },
    ]);
    await calls.performActions(childInput, initial);
    expect(
      (
        await admin.query(
          "select sequence from app.run_events where workflow_run_id=$1 and type='run.cancel_requested'",
          [childRunId],
        )
      ).rows,
    ).toHaveLength(1);
    expect((await outcome(fixture.parentRunId)).slot_lent).toBe(true);
    await runs.advance(childInput, (state) => {
      const previous = parseCheckpoint(state.checkpoint);
      return Promise.resolve({
        kind: 'transition',
        previous,
        plan: {
          ...fixture.plan,
          callIntents: [],
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: {
            ...previous,
            revision: 1,
            nextEventSequence: 4,
            cancelRequested: true,
            runStatus: 'canceled',
          },
          events: [{ sequence: 3, name: 'run.canceled', occurredAt }],
        },
      });
    });
    await calls.performActions(fixture.input, initial);
    await calls.performActions(fixture.input, initial);
    expect(await outcome(fixture.parentRunId)).toMatchObject({
      status: 'canceled',
      slot_lent: false,
    });
    expect(
      (
        await admin.query(
          'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
          [fixture.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query('select status from app.workflow_runs where id=$1', [
          fixture.parentRunId,
        ])
      ).rows,
    ).toEqual([{ status: 'failed' }]);
  });

  it('rolls back child/checkpoint/outbox/receipt candidates for target capacity refusal', async () => {
    const fixture = await pending(true);
    await admin.query(
      'insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit) values($1,$2,1)',
      [fixture.workspaceId, fixture.childWorkflowId],
    );
    await calls.performActions(fixture.input, initial);
    expect(await outcome(fixture.parentRunId)).toMatchObject({
      status: 'refused',
      child_run_id: null,
      slot_lent: false,
      safe_error_code: 'call_target_capacity_exceeded',
    });
    expect(
      (
        await admin.query(
          'select id from app.workflow_runs where workflow_id=$1',
          [fixture.childWorkflowId],
        )
      ).rows,
    ).toEqual([{ id: fixture.childRunId }]);
    expect(
      (
        await admin.query(
          'select id from app.idempotency_records where workspace_id=$1 and scope like $2',
          [fixture.workspaceId, 'workflow-call:%'],
        )
      ).rows,
    ).toEqual([]);
  });

  it.each(['archive', 'input'] as const)(
    'records a definite %s refusal without a child',
    async (kind) => {
      const fixture = await pending();
      if (kind === 'archive')
        await admin.query(
          "update app.workflows set lifecycle_status='archived' where id=$1",
          [fixture.childWorkflowId],
        );
      await calls.performActions(fixture.input, (projection) => ({
        ...initial(projection),
        validateInput: () => {
          throw new CallableInputInvalidError({
            path: [],
            code: 'type_mismatch',
          });
        },
      }));
      expect(await outcome(fixture.parentRunId)).toMatchObject({
        status: 'refused',
        child_run_id: null,
        safe_error_code:
          kind === 'archive' ? 'call_target_unavailable' : 'call_input_invalid',
      });
      expect(
        (
          await admin.query(
            'select id from app.workflow_runs where workflow_id=$1',
            [fixture.childWorkflowId],
          )
        ).rows,
      ).toEqual([]);
    },
  );
}
