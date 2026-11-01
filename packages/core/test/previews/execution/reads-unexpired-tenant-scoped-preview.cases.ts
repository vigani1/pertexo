import { eq } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { readPreviewRun } from '../../../src/previews/runs/records.queries.js';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';

import {
  workspaceA,
  workspaceB,
  actorId,
  apiDatabase,
  workerDatabase,
  input,
  ownerWorkspaceQuery,
  apiPreviews,
} from './fixture.js';
import { hasPostgresCode } from './fixture.js';

export function registerReadsUnexpiredTenantScopedPreview(): void {
  it('reads only an unexpired tenant-scoped preview and its stored output', async () => {
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = '{"kind":"inline","value":{"ok":true}}'
       where id = $1`,
      [accepted.previewRunId],
    );
    await expect(
      apiPreviews.readPreview({
        workspaceId: workspaceA,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
    ).resolves.toMatchObject({
      id: accepted.previewRunId,
      status: 'succeeded',
      output: { kind: 'inline', value: { ok: true } },
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set output_ref = to_jsonb(
         '{"kind":"inline","value":{"ok":true}}'::text
       )
       where id = $1`,
      [accepted.previewRunId],
    );
    await expect(
      apiPreviews.readPreview({
        workspaceId: workspaceA,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
    ).resolves.toMatchObject({
      output: { kind: 'inline', value: { ok: true } },
    });
    await expect(
      apiPreviews.readPreview({
        workspaceId: workspaceB,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
    ).resolves.toBeNull();

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        readPreviewRun(
          transaction,
          {
            actorUserId: actorId,
            previewRunId: accepted.previewRunId,
          },
          'builder',
          accepted.expiresAt,
        ),
      ),
    ).resolves.toBeNull();
  });

  it('scopes preview reads and keeps the provider idempotency key fixed', async () => {
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    const attemptId = accepted.previewAttemptId;
    if (attemptId === null)
      throw new Error('Fixture requires a real preview attempt');
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(await db.select().from(previewRuns)).toHaveLength(1);
    });
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .update(previewAttempts)
          .set({ providerIdempotencyKey: 'changed' })
          .where(eq(previewAttempts.id, attemptId)),
      ).rejects.toSatisfy((error: unknown) => hasPostgresCode(error, '42501'));
    });
  });
}
