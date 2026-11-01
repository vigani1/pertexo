import { waitForBlockedBy } from '../../../support/postgres/lock-coordination.js';
import { expect, it } from 'vitest';

import {
  workspaceId,
  ownerPool,
  enforceTestRetention,
  migrationUrl,
  randomUUID,
  queryAsOwner,
  WorkflowNotFoundError,
  Pool,
  withApplicationName,
} from '../../../support/workflow-authoring.js';
import { database, command, facts, importReceipts } from './fixture.js';

export function registerAnswersExactRetryExpiredReceipt(): void {
  it('answers an exact retry from an expired receipt until retention removes it after its lock', async () => {
    const db = database();
    const input = command();
    const accepted = await db.importWorkflow(input);
    const receipt = [workspaceId, accepted.workflowId] as const;
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.import' and resource_id=$2",
      [...receipt],
      workspaceId,
    );
    expect(await db.importWorkflow(input)).toEqual(accepted);

    // Retention waits for a transaction that holds the receipt, as a retry does.
    const application = `portable-receipt-${randomUUID()}`;
    const pool = new Pool({
      connectionString: withApplicationName(migrationUrl, application),
      max: 1,
    });
    const holder = await pool.connect();
    let reaping: Promise<unknown> | undefined;
    try {
      await holder.query('begin');
      await holder.query('set local role pertexo_owner');
      await holder.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await holder.query(
        "select 1 from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2 for update",
        [...receipt],
      );
      reaping = enforceTestRetention();
      const backend = await holder.query<{ pid: number }>(
        'select pg_backend_pid() pid',
      );
      const pid = backend.rows[0]?.pid;
      if (pid === undefined) throw new Error('Receipt lock holder is missing');
      await waitForBlockedBy(ownerPool, pid);
      expect(await importReceipts(receipt)).toHaveLength(1);
      await holder.query('commit');
      await reaping;
      expect(await importReceipts(receipt)).toEqual([]);
    } finally {
      await holder.query('rollback');
      holder.release();
      await Promise.allSettled(reaping === undefined ? [] : [reaping]);
      await pool.end();
    }
  });

  it('fails closed on a missing accepted destination rather than creating a second workflow', async () => {
    const db = database();
    const input = command();
    const accepted = await db.importWorkflow(input);
    await queryAsOwner(
      'delete from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    await queryAsOwner(
      'delete from app.workflows where workspace_id=$1 and id=$2',
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    const before = await facts();
    await expect(db.importWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    expect(await facts()).toEqual(before);
  });
}
