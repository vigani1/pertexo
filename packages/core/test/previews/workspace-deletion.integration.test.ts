import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { changeWorkspaceLifecycle } from '../../src/lifecycle/deletion/change.js';
import { claimPreviewDelivery } from '../../src/previews/attempts/claim.js';
import { markPreviewDispatched } from '../../src/previews/attempts/mark-dispatched.js';
import { heartbeatPreviewLease } from '../../src/previews/attempts/heartbeat.js';
import { completePreviewAttempt } from '../../src/previews/attempts/complete.js';
import { PreviewAttemptStateError } from '../../src/previews/preview.errors.js';
import {
  acceptFixture,
  claimFixture,
  apiPool,
  workerPool,
  workspaceId,
  actorUserId,
  withAdmin,
} from './worker.fixture.js';

async function deleteWorkspace() {
  const operationId = randomUUID();
  const digest = createHash('sha256').update(operationId).digest('hex');
  await changeWorkspaceLifecycle(apiPool, {
    operationId,
    workspaceId,
    actorUserId,
    commandType: 'deletion_requested',
    reason: 'Stop previews',
    idempotencyKeyHash: digest,
    requestHash: digest,
  });
}

async function resetWorkspace() {
  await withAdmin((db) =>
    db.query(
      `update app.workspaces set status='active',deletion_requested_at=null,
     deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
      [workspaceId],
    ),
  );
}

async function storedStatus(previewRunId: string) {
  return withAdmin(
    async (db) =>
      (
        await db.query<{
          status: string;
          attempt_status: string;
          dispatch_marked_at: Date | null;
        }>(
          `select run.status,attempt.status attempt_status,attempt.dispatch_marked_at
     from app.preview_runs run join app.preview_attempts attempt on attempt.preview_run_id=run.id
     where run.id=$1`,
          [previewRunId],
        )
      ).rows,
  );
}

describe('workspace lifecycle preview dispatch fence', () => {
  it('cancels queued previews and refuses their first claim after deletion commits', async () => {
    const fixture = await acceptFixture();
    try {
      await deleteWorkspace();
      await expect(
        claimPreviewDelivery(workerPool, {
          ...fixture,
          workspaceId,
          workerId: 'deleted-queued',
          leaseDurationSeconds: 30,
        }),
      ).rejects.toBeInstanceOf(PreviewAttemptStateError);
      expect(await storedStatus(fixture.previewRunId)).toEqual([
        {
          status: 'canceled',
          attempt_status: 'canceled',
          dispatch_marked_at: null,
        },
      ]);
    } finally {
      await resetWorkspace();
    }
  });

  it('revokes a claimed but undispatched preview before another provider call can begin', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'deleted-claimed',
    );
    try {
      await deleteWorkspace();
      await expect(
        markPreviewDispatched(workerPool, claimed),
      ).rejects.toBeInstanceOf(PreviewAttemptStateError);
      await expect(
        heartbeatPreviewLease(workerPool, {
          ...claimed,
          leaseDurationSeconds: 30,
        }),
      ).rejects.toBeInstanceOf(PreviewAttemptStateError);
      expect(await storedStatus(claimed.fixture.previewRunId)).toEqual([
        {
          status: 'canceled',
          attempt_status: 'canceled',
          dispatch_marked_at: null,
        },
      ]);
    } finally {
      await resetWorkspace();
    }
  });

  it('preserves the truthful completion of a provider call dispatched before deletion', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'already-dispatched',
    );
    await markPreviewDispatched(workerPool, claimed);
    try {
      await deleteWorkspace();
      await expect(
        completePreviewAttempt(workerPool, {
          ...claimed,
          delivery: claimed.fixture.delivery,
          outcome: {
            status: 'succeeded',
            output: { kind: 'inline', value: 'confirmed' },
          },
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(await storedStatus(claimed.fixture.previewRunId)).toMatchObject([
        { status: 'succeeded', attempt_status: 'succeeded' },
      ]);
    } finally {
      await resetWorkspace();
    }
  });

  it('waits for a pending deletion transaction before deciding whether dispatch may begin', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'racing-deletion',
    );
    try {
      await withAdmin(async (db) => {
        const deletion = await db.connect();
        let dispatch: Promise<unknown> | undefined;
        try {
          await deletion.query('begin');
          await deletion.query(
            `update app.workspaces set status='pending_deletion',
             deletion_requested_at=clock_timestamp(),deletion_requested_by=created_by,
             deletion_reason='Race',purge_after=clock_timestamp()+interval '30 days' where id=$1`,
            [workspaceId],
          );
          dispatch = markPreviewDispatched(workerPool, claimed).catch(
            (error: unknown) => error,
          );
          await withAdmin(async (monitor) => {
            await expect
              .poll(
                async () =>
                  (
                    await monitor.query<{ blocked: boolean }>(
                      `select exists(select 1 from pg_stat_activity where datname=current_database()
               and wait_event_type='Lock' and query like '%lock_workspace_run_admission%') blocked`,
                    )
                  ).rows[0]?.blocked,
              )
              .toBe(true);
          });
          await deletion.query('commit');
          expect(await dispatch).toBeInstanceOf(PreviewAttemptStateError);
          expect(
            await storedStatus(claimed.fixture.previewRunId),
          ).toMatchObject([{ dispatch_marked_at: null }]);
        } finally {
          await deletion.query('rollback');
          deletion.release();
          await dispatch;
        }
      });
    } finally {
      await resetWorkspace();
    }
  });

  it('refuses provider dispatch while the workspace is suspended', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'suspended-preview',
    );
    try {
      await withAdmin((db) =>
        db.query("update app.workspaces set status='suspended' where id=$1", [
          workspaceId,
        ]),
      );
      await expect(
        markPreviewDispatched(workerPool, claimed),
      ).rejects.toBeInstanceOf(PreviewAttemptStateError);
      await expect(
        heartbeatPreviewLease(workerPool, {
          ...claimed,
          leaseDurationSeconds: 30,
        }),
      ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    } finally {
      await resetWorkspace();
    }
  });
});
