import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import { createCheckpoint } from '../../../../workflow-engine/dist/index.js';
import {
  parseCheckpoint,
  type WorkflowTransitionPlan,
} from '../../../../workflow-engine/dist/index.js';
import { createRunAdvanceStore } from '../../../src/runs/advance/store.js';
import { createWorkflowCallStore } from '../../../src/runs/calls/store.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { admin } from '../../lifecycle/calls/fixtures.js';
import {
  apiUrl,
  maintenanceUrl,
  waitForPostgresLock,
  withApplicationName,
} from '../../lifecycle/retention.support.js';
import { randomUUID } from 'node:crypto';
import { declarationFixture } from './storage-fixtures.js';

let runs: ReturnType<typeof createRunAdvanceStore>;
let calls: ReturnType<typeof createWorkflowCallStore>;
let maintenance: Pool;
beforeAll(() => {
  runs = createRunAdvanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  calls = createWorkflowCallStore(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
  );
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
});
afterAll(async () => {
  await Promise.all([runs.close(), calls.close(), maintenance.end()]);
});

async function pending(keepExistingChild = false) {
  const fixture = await declarationFixture();
  if (!keepExistingChild)
    await admin.query('delete from app.workflow_runs where id=$1', [
      fixture.childRunId,
    ]);
  await runs.advance(
    {
      workspaceId: fixture.workspaceId,
      runId: fixture.parentRunId,
      delivery: fixture.delivery,
      signal: new AbortController().signal,
    },
    () =>
      Promise.resolve({
        kind: 'transition',
        previous: fixture.previous,
        plan: fixture.plan,
      }),
  );
  const hint = (
    await admin.query<{ id: string; payload_checksum: string }>(
      'select id,payload_checksum from app.outbox_events where aggregate_id=$1 and id<>$2',
      [fixture.parentRunId, fixture.delivery.outboxEventId],
    )
  ).rows[0];
  if (hint === undefined) throw new Error('Call wakeup missing');
  return {
    ...fixture,
    input: {
      workspaceId: fixture.workspaceId,
      runId: fixture.parentRunId,
      signal: new AbortController().signal,
      delivery: {
        outboxEventId: hint.id,
        payloadChecksum: hint.payload_checksum,
      },
    },
  };
}
const initial: Parameters<typeof calls.performActions>[1] = (projection) => ({
  checkpoint: createCheckpoint({
    workflowVersionId: projection.id,
    iterationBudget: 200,
  }),
});
async function outcome(parentRunId: string) {
  const row = (
    await admin.query<{
      id: string;
      status: string;
      child_run_id: string | null;
      slot_lent: boolean;
      safe_error_code: string | null;
    }>('select * from app.workflow_calls where parent_run_id=$1', [parentRunId])
  ).rows[0];
  if (row === undefined) throw new Error('Call record missing');
  return row;
}

describe('ordinary run acceptance as a durable Call action', () => {
  it.each(['request', 'settlement'] as const)(
    'does not spawn after an opposing parent cancellation %s commits',
    async (kind) => {
      const fixture = await pending();
      const name = `call-close-${randomUUID()}`;
      const competing = createWorkflowCallStore(
        parseDatabaseConfig({
          connectionString: withApplicationName(maintenanceUrl, name),
          max: 1,
        }),
      );
      const blocker = new Pool({ connectionString: apiUrl, max: 1 });
      const held = await blocker.connect();
      let accepting: Promise<void> | undefined;
      try {
        await held.query('begin');
        await held.query("select set_config('app.workspace_id',$1,true)", [
          fixture.workspaceId,
        ]);
        await held.query(
          'select id from app.workflow_runs where id=$1 for no key update',
          [fixture.parentRunId],
        );
        accepting = competing.performActions(fixture.input, initial);
        await waitForPostgresLock(name);
        await held.query(
          kind === 'request'
            ? "update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_reason='user_requested',cancel_requested_by='call-close-test' where id=$1"
            : "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1",
          [fixture.parentRunId],
        );
        await held.query('commit');
        await accepting;
        expect(await outcome(fixture.parentRunId)).toMatchObject({
          status: 'pending',
          child_run_id: null,
          slot_lent: false,
        });
        expect(
          (
            await admin.query(
              'select id from app.workflow_runs where workflow_id=$1',
              [fixture.childWorkflowId],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await held.query('rollback');
        await accepting;
        held.release();
        await Promise.all([competing.close(), blocker.end()]);
      }
    },
  );

  it('accepts one real child at capacity one, lends the existing slot, and recovers after action commit before receipt completion', async () => {
    const fixture = await pending();
    await admin.query(
      'insert into app.workspace_execution_entitlement_versions(workspace_id,version,active_run_limit,queued_run_limit) values($1,2,1,100)',
      [fixture.workspaceId],
    );
    await admin.query(
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [fixture.workspaceId],
    );
    await calls.performActions(fixture.input, initial);
    const saved = await outcome(fixture.parentRunId);
    expect(saved).toMatchObject({ status: 'accepted', slot_lent: true });
    expect(saved.child_run_id).not.toBeNull();
    const child = (
      await admin.query(
        'select status,trigger_type,input_ref,workflow_version_id,deadline_at from app.workflow_runs where id=$1',
        [saved.child_run_id],
      )
    ).rows[0] as unknown;
    expect(child).toMatchObject({
      status: 'queued',
      trigger_type: 'workflow_call',
      input_ref: { kind: 'inline', value: { declared: true } },
      workflow_version_id: fixture.childVersionId,
    });
    expect(
      (
        await admin.query(
          'select message_id from app.inbox_receipts where message_id=$1',
          [fixture.input.delivery.outboxEventId],
        )
      ).rows,
    ).toEqual([]);
    await admin.query(
      'delete from app.idempotency_records where resource_id=$1',
      [saved.child_run_id],
    );
    await calls.performActions(fixture.input, initial);
    expect(await outcome(fixture.parentRunId)).toEqual(saved);
    expect(
      (
        await admin.query(
          'select id from app.workflow_runs where workflow_id=$1',
          [fixture.childWorkflowId],
        )
      ).rows,
    ).toEqual([{ id: saved.child_run_id }]);
    await withTenantScopedClient(
      maintenance,
      { workspaceId: fixture.workspaceId },
      async (client) => {
        expect(
          (
            await client.query(
              'select active_runs,reserved_active_slots from app.workflow_run_slot_counts($1)',
              [fixture.workspaceId],
            )
          ).rows,
        ).toEqual([{ active_runs: 0, reserved_active_slots: 1 }]);
      },
    );
  });

  it('leaves the durable intent replayable after a pre-commit process failure', async () => {
    const fixture = await pending();
    await expect(
      calls.performActions(fixture.input, () => {
        throw new Error('interrupted before child acceptance');
      }),
    ).rejects.toThrow(/interrupted/u);
    expect(await outcome(fixture.parentRunId)).toMatchObject({
      status: 'pending',
      child_run_id: null,
      slot_lent: false,
    });
    expect(
      (
        await admin.query(
          'select id from app.workflow_runs where workflow_id=$1',
          [fixture.childWorkflowId],
        )
      ).rows,
    ).toEqual([]);
    await calls.performActions(fixture.input, initial);
    expect(await outcome(fixture.parentRunId)).toMatchObject({
      status: 'accepted',
      slot_lent: true,
    });
  });

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
});
