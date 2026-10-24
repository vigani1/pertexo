import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';
import {
  ArtifactLifecycleConflictError,
  ArtifactMetadataNotFoundError,
  claimDueUnfinalizedArtifact,
  claimDueUnfinalizedArtifacts,
  completeArtifactRemoval,
  createPendingArtifact,
  finalizeArtifactUpload,
} from '../../../src/artifacts/repository.js';

import {
  database,
  workspaceA,
  pendingInput,
  waitForMilestone,
} from './fixture.js';

export function registerRejectsLateFinalizeAfterPending(): void {
  it('rejects a late finalize after pending metadata has expired', async () => {
    const input = pendingInput({ expiresAt: new Date(Date.now() - 1_000) });
    await database.withWorkspace(workspaceA, (transaction) =>
      createPendingArtifact(transaction, input),
    );

    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        finalizeArtifactUpload(transaction, {
          artifactId: input.artifactId,
          byteLength: input.byteLength,
          mediaType: input.mediaType,
          sha256: input.sha256,
          storageKey: input.storageKey,
          workspaceId: workspaceA,
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactLifecycleConflictError);
  });

  it('claims only due pending uploads and completes metadata removal', async () => {
    const due = pendingInput({ expiresAt: new Date(Date.now() - 60_000) });
    const future = pendingInput();
    const available = pendingInput();
    await database.withWorkspace(workspaceA, async (transaction) => {
      await createPendingArtifact(transaction, due);
      await createPendingArtifact(transaction, future);
      await createPendingArtifact(transaction, available);
      await finalizeArtifactUpload(transaction, {
        artifactId: available.artifactId,
        byteLength: available.byteLength,
        mediaType: available.mediaType,
        sha256: available.sha256,
        storageKey: available.storageKey,
        workspaceId: workspaceA,
      });
    });

    const claimed = await database.withWorkspace(workspaceA, (transaction) =>
      claimDueUnfinalizedArtifacts(transaction, {
        limit: 10,
      }),
    );
    expect(claimed.map((artifact) => artifact.id)).toEqual([due.artifactId]);
    expect(claimed[0]?.status).toBe('deleting');
    const resumed = await database.withWorkspace(workspaceA, (transaction) =>
      claimDueUnfinalizedArtifact(transaction, {
        artifactId: due.artifactId,
      }),
    );
    expect(resumed.status).toBe('deleting');

    const deleted = await database.withWorkspace(workspaceA, (transaction) =>
      completeArtifactRemoval(transaction, { artifactId: due.artifactId }),
    );
    expect(deleted.status).toBe('deleted');
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        completeArtifactRemoval(transaction, { artifactId: due.artifactId }),
      ),
    ).resolves.toEqual(deleted);

    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        completeArtifactRemoval(transaction, {
          artifactId: available.artifactId,
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactLifecycleConflictError);
    await expect(
      database.withWorkspace(workspaceA, (transaction) =>
        completeArtifactRemoval(transaction, { artifactId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
  });

  it('uses skip-locked claims while another maintenance batch holds its row locks', async () => {
    const due = Array.from({ length: 4 }, () =>
      pendingInput({ expiresAt: new Date(Date.now() - 60_000) }),
    );
    await database.withWorkspace(workspaceA, async (transaction) => {
      for (const input of due) await createPendingArtifact(transaction, input);
    });

    const firstClaimed = Promise.withResolvers<undefined>();
    const releaseFirst = Promise.withResolvers<undefined>();
    const first = database.withWorkspace(workspaceA, async (transaction) => {
      const locked = await transaction.db.execute<{ id: string }>(sql`
        select id
        from app.artifacts
        where workspace_id=${transaction.workspaceId}
          and status='pending'
          and expires_at <= clock_timestamp()
        order by expires_at,id
        limit 2
        for update
      `);
      firstClaimed.resolve(undefined);
      await releaseFirst.promise;
      return locked.rows.map((row) => row.id);
    });
    try {
      await waitForMilestone(firstClaimed.promise, first, 'first claim lock');
      const right = await database.withWorkspace(workspaceA, (transaction) =>
        claimDueUnfinalizedArtifacts(transaction, {
          limit: 2,
        }),
      );
      expect(right).toHaveLength(2);
      releaseFirst.resolve(undefined);
      const left = await first;
      expect(left).toHaveLength(2);
      expect(
        new Set([...left, ...right.map((artifact) => artifact.id)]).size,
      ).toBe(4);
    } finally {
      releaseFirst.resolve(undefined);
      await first;
    }
  });
}
