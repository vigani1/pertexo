import { expect, it } from 'vitest';

import { actor, database, ownerTransaction, workspaceId } from './fixture.js';

export function registerCancelsBlockedFinalization(): void {
  it('cancels a finalization waiting in its database update and keeps the upload pending', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 37,
      idempotencyKey: 'finalize-upload-blocked-abort',
      mediaType: 'application/octet-stream',
      sha256: '9'.repeat(64),
      workspaceId,
    });
    const identity = {
      actor: actor(),
      identity: { artifactId: created.artifact.id, workspaceId },
    } as const;
    const controller = new AbortController();
    const reason = new Error('request canceled while finalizing');

    await ownerTransaction(async (holder) => {
      await holder.query(
        'select id from app.artifacts where workspace_id=$1 and id=$2 for update',
        [workspaceId, created.artifact.id],
      );
      const finalizing = database.finalizeUpload({
        ...identity,
        expectedMetadata: {
          byteLength: 37,
          mediaType: 'application/octet-stream',
          sha256: '9'.repeat(64),
        },
        signal: controller.signal,
      });
      const canceled = expect(finalizing).rejects.toMatchObject({
        name: 'AbortError',
      });
      await expect
        .poll(
          () =>
            ownerTransaction(
              async (monitor) =>
                (
                  await monitor.query<{ waiting: boolean }>(
                    `select exists(select 1 from pg_locks l
                      join pg_stat_activity a using (pid)
                      where a.datname=current_database() and not l.granted) waiting`,
                  )
                ).rows[0]?.waiting,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      controller.abort(reason);
      await canceled;
    });

    await expect(database.getForUpload(identity)).resolves.toMatchObject({
      status: 'pending',
    });
  });
}
