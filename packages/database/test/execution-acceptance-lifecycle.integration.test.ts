import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  WorkspaceRunAdmissionDeniedError,
} from '../src/runs/commands/acceptance.js';
import { changeWorkspaceLifecycle } from '../src/lifecycle/workspace-deletion.js';
import { runEvents } from '../src/schema.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  installExecutionAcceptanceFixture,
  apiUrl,
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
    let admission: ReturnType<typeof acceptWorkflowRun> | undefined;
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

      admission = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const observedAdmission = admission.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForDatabaseLock(deletionProcessId);

      await deletion.query('commit');
      expect(await observedAdmission).toBeInstanceOf(
        WorkspaceRunAdmissionDeniedError,
      );
      await expectAcceptanceRecordCounts(0);
    } catch (error: unknown) {
      await deletion.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await deletion.query('rollback').catch(() => undefined);
      if (admission !== undefined) await Promise.allSettled([admission]);
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
    const observedAdmission = admission.then(
      () => undefined,
      (error: unknown) => error,
    );
    const beforeBarrier = await Promise.race([
      admissionLocked.then(() => undefined),
      observedAdmission,
    ]);
    if (beforeBarrier instanceof Error) throw beforeBarrier;

    const app = new Pool({ connectionString: apiUrl, max: 1 });
    const deletionClient = await app.connect();
    const deletionProcessId = await deletionClient
      .query<{ process_id: number }>('select pg_backend_pid() process_id')
      .then(({ rows }) => rows[0]?.process_id);
    if (deletionProcessId === undefined)
      throw new Error('Expected racing-deletion database process');
    await deletionClient.query('begin');
    await deletionClient.query(
      "select set_config('app.workspace_id',$1,true), set_config('app.actor_id',$2,true)",
      [workspaceA, workspaceCreatorId],
    );
    const deletion = changeWorkspaceLifecycle(deletionClient, {
      operationId: randomUUID(),
      workspaceId: workspaceA,
      actorUserId: workspaceCreatorId,
      commandType: 'deletion_requested',
      reason: 'concurrent deletion',
      idempotencyKeyHash: 'c'.repeat(64),
      requestHash: 'd'.repeat(64),
    });
    try {
      await waitForDatabaseLock(deletionProcessId, 'waiter');

      releaseAdmission();
      const accepted = await admission;
      expect(accepted).toMatchObject({
        duplicate: false,
        status: 'queued',
      });
      await expect(deletion).resolves.toMatchObject({
        commandType: 'deletion_requested',
      });
      await deletionClient.query('commit');
      // The deletion requests the admitted run's cancellation; the
      // coordinator finishes it.
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await expect(
          db
            .select({ type: runEvents.type })
            .from(runEvents)
            .where(eq(runEvents.workflowRunId, accepted.runId))
            .orderBy(runEvents.sequence),
        ).resolves.toEqual([
          { type: 'run.queued' },
          { type: 'run.cancel_requested' },
        ]);
      });
    } finally {
      releaseAdmission();
      await Promise.allSettled([admission, deletion]);
      await deletionClient.query('rollback').catch(() => undefined);
      deletionClient.release();
      await app.end();
    }
  });
});
