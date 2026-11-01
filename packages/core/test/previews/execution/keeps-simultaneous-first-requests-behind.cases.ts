import { count } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { acceptPreviewRun } from '../../../src/previews/runs/acceptance.repository.js';
import { PreviewAdmissionDeniedError } from '../../../src/previews/errors.js';
import { resolvePreviewReplay } from '../../../src/previews/runs/replay.repository.js';
import {
  auditEvents,
  idempotencyRecords,
  outboxEvents,
  previewAttempts,
  previewRuns,
} from '@pertexo/database/schema';

import {
  workspaceA,
  workspaceB,
  actorId,
  workflowA,
  keyHash,
  requestHash,
  apiDatabase,
  input,
  ownerWorkspaceQuery,
} from './fixture.js';

export function registerKeepsSimultaneousFirstRequestsBehind(): void {
  it('keeps simultaneous first requests behind one atomic acceptance', async () => {
    const results = await Promise.all([
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input()),
      ),
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input()),
      ),
    ]);

    expect(results.map(({ duplicate }) => duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      new Set(results.map(({ previewRunId }) => previewRunId)),
    ).toHaveProperty('size', 1);
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(await db.select({ count: count() }).from(previewRuns)).toEqual([
        { count: 1 },
      ]);
      expect(await db.select({ count: count() }).from(previewAttempts)).toEqual(
        [{ count: 1 }],
      );
      expect(await db.select({ count: count() }).from(outboxEvents)).toEqual([
        { count: 1 },
      ]);
    });
  });

  it('denies revoked replay lookup and hides another workspace claim', async () => {
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(transaction, input()),
    );
    await expect(
      apiDatabase.withWorkspace(workspaceB, (transaction) =>
        resolvePreviewReplay(transaction, {
          actorUserId: actorId,
          workflowId: workflowA,
          keyHash,
          requestHash,
        }),
      ),
    ).resolves.toBeNull();

    await ownerWorkspaceQuery(
      workspaceA,
      `update app.workspace_memberships set status = 'suspended'
       where workspace_id = $1 and user_id = $2`,
      [workspaceA, actorId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        resolvePreviewReplay(transaction, {
          actorUserId: actorId,
          workflowId: workflowA,
          keyHash,
          requestHash,
        }),
      ),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
  });

  it('rolls every acceptance fact back with its caller transaction', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptPreviewRun(transaction, input());
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      for (const table of [
        previewRuns,
        previewAttempts,
        idempotencyRecords,
        outboxEvents,
        auditEvents,
      ] as const)
        expect(await db.select({ count: count() }).from(table)).toEqual([
          { count: 0 },
        ]);
    });
  });

  it('rejects stale draft and inactive builder admission before persistence', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input({ draftRevision: 2 })),
      ),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.workspace_memberships set status = 'suspended'
       where workspace_id = $1 and user_id = $2`,
      [workspaceA, actorId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input()),
      ),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
  });
}
