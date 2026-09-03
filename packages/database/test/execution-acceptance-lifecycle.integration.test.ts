import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  WorkspaceRunAdmissionDeniedError,
} from '../src/execution/execution-acceptance.js';
import { runEvents, workflowRuns } from '../src/schema.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  installExecutionAcceptanceFixture,
  migrationUrl,
  waitForDatabaseLock,
  workspaceA,
  workspaceCreatorId,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

describe('workflow run lifecycle serialization', () => {
  it('fails closed when the workspace lifecycle row does not exist', async () => {
    await expect(
      apiDatabase.withWorkspace(randomUUID(), (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    await expectAcceptanceRecordCounts(0);
  });

  it('waits for an in-flight deletion and rejects after deletion wins the row lock', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const deletion = await owner.connect();
    const deletionProcessId = await deletion
      .query<{ process_id: number }>('select pg_backend_pid() process_id')
      .then(({ rows }) => rows[0]?.process_id);
    if (deletionProcessId === undefined)
      throw new Error('Expected workspace-deletion database process');
    try {
      await deletion.query('begin');
      await deletion.query('set local role pertexo_owner');
      await deletion.query(
        `update app.workspaces
         set status = 'pending_deletion',
             deletion_requested_at = now(),
             deletion_requested_by = $2,
             deletion_reason = 'concurrent deletion',
             purge_after = now() + interval '30 days'
         where id = $1`,
        [workspaceA, workspaceCreatorId],
      );

      const admission = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      await waitForDatabaseLock(deletionProcessId);

      await deletion.query('commit');
      await expect(admission).rejects.toBeInstanceOf(
        WorkspaceRunAdmissionDeniedError,
      );
      await expectAcceptanceRecordCounts(0);
    } catch (error: unknown) {
      await deletion.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      deletion.release();
      await owner.end();
    }
  });

  it('lets an admitted run commit before a racing deletion takes effect', async () => {
    let releaseAdmission!: () => void;
    const holdAdmission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let acceptanceLocked!: () => void;
    const admissionLocked = new Promise<void>((resolve) => {
      acceptanceLocked = resolve;
    });

    const admission = apiDatabase.withWorkspace(
      workspaceA,
      async (transaction) => {
        const accepted = await acceptWorkflowRun(
          transaction,
          acceptanceInput(),
        );
        acceptanceLocked();
        await holdAdmission;
        return accepted;
      },
    );
    await admissionLocked;

    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const deletionClient = await owner.connect();
    const deletionProcessId = await deletionClient
      .query<{ process_id: number }>('select pg_backend_pid() process_id')
      .then(({ rows }) => rows[0]?.process_id);
    if (deletionProcessId === undefined)
      throw new Error('Expected racing-deletion database process');
    await deletionClient.query('begin');
    await deletionClient.query('set local role pertexo_owner');
    const deletion = deletionClient.query(
      `update app.workspaces
       set status = 'pending_deletion',
           deletion_requested_at = now(),
           deletion_requested_by = $2,
           deletion_reason = 'concurrent deletion',
           purge_after = now() + interval '30 days'
       where id = $1
       returning status`,
      [workspaceA, workspaceCreatorId],
    );
    try {
      await waitForDatabaseLock(deletionProcessId, 'waiter');

      releaseAdmission();
      const accepted = await admission;
      expect(accepted).toMatchObject({
        duplicate: false,
        status: 'queued',
      });
      await expect(deletion).resolves.toMatchObject({
        rows: [{ status: 'pending_deletion' }],
      });
      await deletionClient.query('commit');
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await expect(
          db
            .select({ status: workflowRuns.status })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, accepted.runId)),
        ).resolves.toEqual([{ status: 'canceled' }]);
        await expect(
          db
            .select({ type: runEvents.type })
            .from(runEvents)
            .where(eq(runEvents.workflowRunId, accepted.runId))
            .orderBy(runEvents.sequence),
        ).resolves.toEqual([
          { type: 'run.queued' },
          { type: 'run.cancel_requested' },
          { type: 'run.canceled' },
        ]);
      });
    } finally {
      releaseAdmission();
      await Promise.allSettled([admission, deletion]);
      await deletionClient.query('rollback').catch(() => undefined);
      deletionClient.release();
      await owner.end();
    }
  });
});
