import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { createWorkflowCallStore } from '../../../../src/runs/calls/repository.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { admin } from '../../../lifecycle/calls/fixtures.js';
import {
  apiUrl,
  maintenanceUrl,
  waitForPostgresLock,
  withApplicationName,
} from '../../../lifecycle/retention.support.js';
import { randomUUID } from 'node:crypto';

import { calls, maintenance, pending, initial, outcome } from './fixture.js';

export function registerDoesNotSpawnAfterOpposing(): void {
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
}
